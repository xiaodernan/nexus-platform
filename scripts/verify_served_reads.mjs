#!/usr/bin/env node
/*
 * Probes the *served* consumer read surface against data that only exists in the database.
 *
 * Why this file is separate from `verify_payload_conformance.mjs` (schemas) and `quality.sql` (rows):
 * neither of them can see the join. A seeded fact can be perfectly well-formed in the table and still
 * never reach a card, because the lateral that carries it filters on something the seeder got wrong —
 * which is exactly the §19 defect D35 closed (520 merchants rendered a rating; the `facts` table had
 * no `rating` row for any of them, and the reader that would have noticed was a row-level check).
 *
 * So every probe here asks one question about a live HTTP response: does the number the page prints
 * carry the fact that means the same number? Assertions are written against what the contract promises
 * a client, never against how the row is stored.
 *
 * Usage: node scripts/verify_served_reads.mjs --base http://127.0.0.1:8092 [--tenant hong-kong]
 * Exit 0 when every probe passes; 1 otherwise. Read-only: nothing here issues a write.
 */

import { parseFlags } from './cli_args.mjs';

/*
 * D158 — the flags come from the shared parser, because this reader used to look them up with
 * `argv.indexOf('--base')`. That reads only the spaced spelling, so `--tenant=d158-not-a-tenant` measured the
 * seeded tenant and printed `RESULT: PASS — 626 served-read checks passed against http://127.0.0.1:8090`: the
 * run answered a question nobody asked it, and the one number a caller cannot see in that line is the tenant,
 * which is why the tenant is printed on both verdict paths now. An option this reader does not name is refused
 * with exit 2 instead of being dropped.
 */
const SPEC = { '--base': { kind: 'value', unit: 'service URL' }, '--tenant': { kind: 'value', unit: 'tenant id' } };
const argv = process.argv.slice(2);
const parsed = parseFlags(argv, SPEC);
if (!parsed.ok) {
  console.log('NEXUS — served consumer reads');
  console.log(`  RESULT: NOT CHECKED — ${parsed.reason}`);
  process.exit(2);
}
const BASE = (parsed.value['--base'] ?? 'http://127.0.0.1:8090').replace(/\/$/, '');
const TENANT = parsed.value['--tenant'] ?? 'hong-kong';

// What this run has actually managed to address things by, so the surface sweep fills real ids
// rather than inventing ones it cannot resolve.
const run = { slug: null, merchantId: null, offeringSlug: null, guideSlug: null, collectionSlug: null };

const failures = [];
const notes = [];
let checks = 0;
const ok = (label, condition, detail) => {
  checks += 1;
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const note = (label, value) => notes.push(`${label}: ${value}`);

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Tenant': TENANT, Accept: 'application/json' } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body };
}

const factFor = (payload, attribute) =>
  (payload?.facts ?? []).find((f) => f.attribute === attribute) ?? null;

/** §19 stated as a test: if a rating is printed, a rating fact is present, and the two agree. */
function ratingIsBacked(card, where) {
  const rating = card?.rating;
  if (!rating || rating.value === null || rating.count === 0) {
    ok(`${where}: no rating printed, so no rating fact is claimed`, !factFor(card, 'rating'),
      `fact present without a printed rating: ${JSON.stringify(factFor(card, 'rating')?.value)}`);
    return;
  }
  const fact = factFor(card, 'rating');
  ok(`${where}: the printed rating carries a fact`, fact !== null,
    `facts=[${(card?.facts ?? []).map((f) => f.attribute).join(',')}]`);
  if (!fact) return;
  ok(`${where}: fact value == printed value`,
    Number(fact.value?.value) === Number(rating.value), `${fact.value?.value} vs ${rating.value}`);
  ok(`${where}: fact count == printed count`,
    Number(fact.value?.count) === Number(rating.count), `${fact.value?.count} vs ${rating.count}`);
  ok(`${where}: fact is provenanced`, typeof fact.source === 'string' && fact.source.length > 0
    && typeof fact.observed_at === 'string' && Number.isFinite(fact.confidence),
    JSON.stringify({ source: fact.source, observed_at: fact.observed_at, confidence: fact.confidence }));
  ok(`${where}: a demo dataset says so`,
    String(fact.source_uri ?? '').startsWith('demo://') || fact.value?.data_origin === 'demo',
    `${fact.source_uri}`);
}

async function main() {
  const health = await get('/api/v1/health');
  ok('service answers /api/v1/health', health.status === 200, `HTTP ${health.status}`);
  if (health.status !== 200) return finish();

  // ---- the directory page: every card on it, not a sample
  const dir = await get('/api/v1/merchants?limit=20&sort=-rating');
  ok('GET /api/v1/merchants', dir.status === 200, `HTTP ${dir.status}`);
  const cards = dir.body?.items ?? [];
  ok('the directory returns a page of cards', cards.length > 0, `${cards.length} items`);
  note('directory cards probed', cards.length);
  let rated = 0;
  for (const card of cards) {
    if (card?.rating?.value != null) rated += 1;
    ratingIsBacked(card, `directory card ${card?.slug}`);
  }
  ok('the seeded directory actually contains ratings (a zero here proves nothing)', rated > 0,
    `${rated} of ${cards.length}`);
  ok('the directory is cacheable and tenant-varying',
    /max-age=\d+/.test(dir.headers.get('cache-control') ?? '')
    && (dir.headers.get('vary') ?? '').includes('X-Tenant'),
    `${dir.headers.get('cache-control')} / ${dir.headers.get('vary')}`);

  // ---- one profile, and the offerings it lists
  const slug = cards.find((c) => c?.slug)?.slug;
  if (!slug) return finish();
  run.slug = slug;
  const profile = await get(`/api/v1/merchants/${slug}`);
  ok(`GET /api/v1/merchants/${slug}`, profile.status === 200, `HTTP ${profile.status}`);
  ratingIsBacked({ ...profile.body, facts: profile.body?.facts ?? [] }, `profile ${slug}`);
  run.merchantId = profile.body?.id ?? slug;
  ok('the profile marks its data origin', profile.headers.get('x-demo-data') !== null,
    'no X-Demo-Data header on a seeded read');

  const menu = await get(`/api/v1/merchants/${slug}/menu`);
  ok(`GET /api/v1/merchants/${slug}/menu`, menu.status === 200, `HTTP ${menu.status}`);
  const offerings = menu.body?.items ?? [];
  const withRating = offerings.filter((o) => o?.rating?.value != null);
  run.offeringSlug = (withRating[0] ?? offerings[0])?.slug ?? null;
  note('menu offerings probed', `${offerings.length} (${withRating.length} rated)`);
  for (const o of withRating) ratingIsBacked(o, `menu offering ${o?.slug}`);

  // ---- the evidence chain: the printed rating, its fact, and the reviews it is the mean of.
  // These come from three different queries — the card's aggregate column, the fact row, and a live
  // count over `reviews` — and one page shows all of them. A merchant can render 「3.79 · 291」 while a
  // distribution that sums to 288 says otherwise, and only a check across the responses can see it.
  const reviews = await get(`/api/v1/merchants/${slug}/reviews?limit=50`);
  ok(`GET /api/v1/merchants/${slug}/reviews`, reviews.status === 200, `HTTP ${reviews.status}`);
  const stats = profile.body?.review_stats ?? {};
  const printed = profile.body?.rating ?? {};
  const distribution = stats.distribution ?? [];
  const distTotal = distribution.reduce((a, d) => a + Number(d?.count || 0), 0);
  const shareTotal = distribution.reduce((a, d) => a + Number(d?.share || 0), 0);
  const ratingFact = factFor({ facts: profile.body?.facts ?? [] }, 'rating');
  note('review evidence', `published=${stats.published_reviews} distribution=${distTotal} `
    + `card=${printed.count} fact=${ratingFact?.value?.count} scope=${reviews.body?.status_scope}`);
  ok('the printed rating, the published count and the distribution all agree',
    Number(printed.count) === Number(stats.published_reviews) && distTotal === Number(printed.count),
    `card ${printed.count} vs published ${stats.published_reviews} vs distribution ${distTotal}`);
  ok('the printed value is the average the stats report',
    Number(printed.value) === Number(stats.average_rating),
    `card ${printed.value} vs stats ${stats.average_rating}`);
  ok('the star shares add up to the whole', Math.abs(shareTotal - 1) < 0.01, `sum ${shareTotal}`);
  ok('the rating fact counts the same reviews',
    Number(ratingFact?.value?.count) === Number(stats.published_reviews),
    `fact ${ratingFact?.value?.count} vs ${stats.published_reviews}`);
  // The fact's evidence window and the stats' newest review are the same event seen through two
  // queries; if they differ, one of them is not describing the reviews that exist.
  ok('the rating fact was taken through the newest review',
    ratingFact === null || stats.latest_review_at === undefined
    || Date.parse(ratingFact.value?.reviewed_through) === Date.parse(stats.latest_review_at),
    `reviewed_through ${ratingFact?.value?.reviewed_through} vs latest ${stats.latest_review_at}`);
  // The scope is a sentence the service states about itself, not a token — what matters to a reader is
  // that it says *which* reviews were counted and names what is left out.
  ok('the review list states its counting scope',
    /published/i.test(String(reviews.body?.status_scope ?? ''))
    && /pending|flagged|rejected/i.test(String(reviews.body?.status_scope ?? '')),
    JSON.stringify(reviews.body?.status_scope));

  // A page is 50 rows and a seeded merchant has up to 443, so walk the cursor rather than assume the
  // first page is the whole set — and prove the cursor advances at all.
  const seen = new Map();
  let cursor = reviews.body?.next_cursor ?? null;
  let pages = 1;
  for (const item of reviews.body?.items ?? []) seen.set(item?.review_id, item);
  while (cursor && pages < 10) {
    const next = await get(`/api/v1/merchants/${slug}/reviews?limit=50&cursor=${encodeURIComponent(cursor)}`);
    if (next.status !== 200) { cursor = null; break; }
    const before = seen.size;
    for (const item of next.body?.items ?? []) seen.set(item?.review_id, item);
    ok(`review page ${pages + 1} contributes new rows`, seen.size > before,
      `${before} -> ${seen.size}`);
    cursor = next.body?.next_cursor ?? null;
    pages += 1;
  }
  note('review pages walked', pages);
  const rows = [...seen.values()];
  ok('every served review is a review of this merchant, with real text',
    rows.length > 0 && rows.every((r) => r?.merchant_id === profile.body?.id
      && Number(r?.rating) >= 1 && Number(r?.rating) <= 5
      && String(r?.body ?? '').trim().length > 20 && r?.review_id && r?.created_at),
    JSON.stringify(rows.slice(0, 2).map((r) => [r?.rating, (r?.body ?? '').length])));
  ok('seeded reviews are marked as demo, not presented as real visitors',
    rows.every((r) => r?.flags?.demo === true),
    JSON.stringify(rows.slice(0, 3).map((r) => [r?.data_origin, r?.flags?.demo])));
  ok('the walk reaches as far as the aggregate counts',
    cursor === null ? rows.length === Number(stats.published_reviews) : rows.length <= distTotal,
    `${rows.length} rows of ${distTotal}, cursor ${cursor === null ? 'exhausted' : 'still going'}`);

  // ---- §8: guides are collections with a kind, and their items resolve or say why not
  const guides = await get('/api/v1/guides');
  ok('GET /api/v1/guides', guides.status === 200, `HTTP ${guides.status}`);
  const listed = guides.body?.items ?? [];
  run.guideSlug = listed[0]?.slug ?? null;
  // A guide slug cannot address a collection route — the two differ only in `kind`, and the read enforces
  // it, so filling `{slug}` under /collections with a guide's slug produces a correct 404 that would look
  // like an unmapped route. Collect one of each instead of guessing across subject types.
  const collections = await get('/api/v1/collections');
  run.collectionSlug = (collections.body?.items ?? [])[0]?.slug ?? null;
  note('published guides', listed.length);
  ok('every listed guide is a guide', listed.every((g) => g?.kind === 'guide'),
    JSON.stringify(listed.map((g) => g?.kind)));
  // The list projection carries the §27 signal itself (`reviewed_by_human`); the verdict (`noindex`) is
  // on the detail, so that is where it is asserted below — asking a summary for a field it never
  // claimed is how a probe manufactures its own failure.
  ok('the guide list reports its review state',
    listed.every((g) => typeof g?.reviewed_by_human === 'boolean'),
    JSON.stringify(listed.map((g) => [g?.slug, g?.reviewed_by_human])));

  for (const entry of listed.slice(0, 3)) {
    const detail = await get(`/api/v1/guides/${entry.slug}`);
    ok(`GET /api/v1/guides/${entry.slug}`, detail.status === 200, `HTTP ${detail.status}`);
    const stored = detail.body?.item_count ?? 0;
    const shown = detail.body?.items?.length ?? 0;
    const dropped = detail.body?.dropped_item_ids?.length ?? 0;
    // D34: `item_count` is the stored size, so nothing may disappear without being named.
    ok(`guide ${entry.slug}: stored items are either rendered or named`, stored === shown + dropped,
      `item_count ${stored} · items ${shown} · dropped ${dropped}`);
    ok(`guide ${entry.slug}: cards mirror the resolved items`,
      (detail.body?.cards?.length ?? 0) === (detail.body?.items ?? []).filter((i) => i?.card).length,
      `cards ${detail.body?.cards?.length} of items ${shown}`);
    for (const card of detail.body?.cards ?? []) {
      ok(`guide ${entry.slug}: an embedded card has its own projection`,
        card?.card_type === 'merchant' && Array.isArray(card?.facts), JSON.stringify(card?.card_type));
      ratingIsBacked(card, `guide ${entry.slug} card ${card?.slug}`);
    }
    const attribution = detail.body?.curated_by ?? {};
    ok(`guide ${entry.slug}: attribution names a real curator or says AI`,
      ['ai', 'creator', 'editorial', 'model'].includes(attribution.type)
      && (attribution.type !== 'ai' || attribution.name === 'AI curation'),
      JSON.stringify(attribution));
    // §27: nothing here has been through a human, so nothing here may be indexed. A guide that answers
    // indexable while `reviewed_by_human` is false is the red line, not a styling question.
    if (detail.body?.reviewed_by_human === false) {
      ok(`guide ${entry.slug}: unreviewed means noindex with a reason (§27)`,
        detail.body?.noindex === true && /review/i.test(String(detail.body?.noindex_reason)),
        JSON.stringify({ noindex: detail.body?.noindex, reason: detail.body?.noindex_reason }));
    }
  }

  // ---- a collection is not a guide, and neither is a typo
  const kindMismatch = await get('/api/v1/guides/quiet-meals-near-me');
  ok('a collection slug does not read as a guide', kindMismatch.status === 404
    && kindMismatch.body?.error?.code === 'guide_not_found',
    `HTTP ${kindMismatch.status} ${kindMismatch.body?.error?.code}`);
  const missing = await get('/api/v1/guides/no-such-guide-xyz');
  ok('an unknown guide slug is a named 404', missing.status === 404
    && typeof missing.body?.error?.code === 'string', `HTTP ${missing.status}`);
  const badKind = await get('/api/v1/collections?kind=blog');
  ok('an unknown kind is a 422 that names the field', badKind.status === 422
    && badKind.body?.error?.details?.field === 'kind', `HTTP ${badKind.status}`);

  // ---- the whole declared surface, not just the routes the author remembered.
  // `/v3/api-docs` is the running service's own list of what it answers, so this is a coverage check
  // rather than an enumeration of hopes: every GET the service advertises gets hit, and a route that
  // 500s, or that the router does not actually have behind the declaration, fails the run. Public reads
  // must return 200; anything needing an id this run does not have must fail *closed* with a named
  // error code — a bare 404 body or a stack-trace status means the contract and the handler disagree.
  await surfaceSweep();

  return finish();
}

/** Hit every GET the running service declares, and hold each response to its declared behaviour. */
async function surfaceSweep(ids) {
  const doc = await get('/v3/api-docs');
  if (doc.status !== 200 || !doc.body?.paths) {
    note('served surface', `unavailable (HTTP ${doc.status}) — coverage not proven`);
    failures.push('the service publishes no OpenAPI document, so its served surface cannot be audited');
    return;
  }
  const gets = Object.entries(doc.body.paths).filter(([, ops]) => ops && ops.get);
  ok('the declared surface contains the consumer reads this suite cares about',
    gets.some(([p]) => p === '/api/v1/merchants')
    && gets.some(([p]) => /guides/.test(p))
    && gets.some(([p]) => /reviews/.test(p)),
    `${gets.length} GET paths declared`);

  let real = 0, reachable = 0, fivedowns = 0, unmapped = 0;
  const reported = [];
  for (const [template] of gets) {
    const values = idsFor(template);
    const filled = template.replace(/\{([^}]+)\}/g, (_, name) =>
      values[name] !== undefined ? values[name] : `zzz-unknown-${name}`);
    const res = await get(filled);
    if (res.status >= 500) {
      fivedowns += 1; reported.push(`5xx on ${filled}`); continue;
    }
    // Failing closed means naming the failure *as that resource*: `guide_not_found` is the handler
    // answering correctly. The platform's catch-all answers 404 with `not_found` / "No such endpoint",
    // which means the OpenAPI document advertises a path the router does not have — accepting that as a
    // legitimate 404 is how this check would hide its own subject, so it is counted as unmapped.
    const domainCode = typeof res.body?.error?.code === 'string' && res.body.error.code !== 'not_found';
    if (res.status === 401 || res.status === 403) { reachable += 1; continue; }   // auth-gated, as designed
    if (res.status >= 400 && !domainCode) {
      unmapped += 1; reported.push(`${res.status} with no route behind it: ${filled}`); continue;
    }
    if (res.status === 200) {
      ok(`served GET ${template} returns JSON`, res.body !== null, 'unparsable body');
      for (const card of cardsIn(res.body)) ratingIsBacked(card, `surface ${template}`);
      real += 1;
    } else reachable += 1;
  }
  note('served surface', `${gets.length} declared GETs · ${real} answered 200 · `
    + `${reachable} failed closed or asked for auth · ${fivedowns} 5xx · ${unmapped} not really mapped`);
  ok('no declared GET route 500s', fivedowns === 0, reported.filter((r) => r.startsWith('5xx')).join('; '));
  ok('every declared GET route answers as itself', unmapped === 0,
    reported.filter((r) => !r.startsWith('5xx')).join('; '));
}

/** The best id this run actually has for each path parameter a declared route asks for. */
function idsFor(template) {
  const ids = {};
  const merchant = /collection|guide/i.test(template) ? null : run.slug;
  if (/idOrSlug/.test(template)) ids.idOrSlug = merchant ?? run.slug;
  if (/\{slug\}/.test(template)) {
    ids.slug = /collections/i.test(template) ? (run.collectionSlug ?? run.slug)
      : /guides/i.test(template) ? (run.guideSlug ?? run.slug)
      : /offerings?/i.test(template) ? (run.offeringSlug ?? run.slug) : run.slug;
  }
  if (/\{id\}/.test(template)) ids.id = /reservation/.test(template) ? 'NX-unknown' : (run.merchantId ?? run.slug);
  if (/merchant_id|merchantId/.test(template)) {
    ids.merchant_id = run.merchantId; ids.merchantId = run.merchantId;
  }
  if (/offering/.test(template) && /\{|offer/.test(template)) ids.offering_slug = run.offeringSlug;
  if (/\{code\}/.test(template)) ids.code = 'NX-unknown';
  return ids;
}

/** Every EntityCard-shaped object anywhere in a payload, however the endpoint nests it. */
function cardsIn(body, found = []) {
  if (body === null || typeof body !== 'object') return found;
  if (Array.isArray(body)) { for (const v of body) cardsIn(v, found); return found; }
  if (typeof body.card_type === 'string' && ('rating' in body || 'facts' in body)) found.push(body);
  for (const v of Object.values(body)) cardsIn(v, found);
  return found;
}

function finish() {
  for (const n of notes) console.log(`  · ${n}`);
  if (failures.length) {
    console.log(`\n  ${failures.length} of ${checks} served-read checks FAILED (against ${BASE} as tenant ${TENANT}):`);
    for (const f of failures.slice(0, 40)) console.log(`    - ${f}`);
    if (failures.length > 40) console.log(`    … ${failures.length - 40} more`);
    console.log('\nRESULT: FAIL');
    process.exit(1);
  }
  console.log(`\nRESULT: PASS — ${checks} served-read checks passed against ${BASE} as tenant ${TENANT}`);
}

main().catch((err) => {
  console.log(`  ${err?.name}: ${err?.message}`);
  console.log('\nRESULT: FAIL');
  process.exit(1);
});
