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

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://127.0.0.1:8090').replace(/\/$/, '');
const TENANT = arg('tenant', 'hong-kong');

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
  const profile = await get(`/api/v1/merchants/${slug}`);
  ok(`GET /api/v1/merchants/${slug}`, profile.status === 200, `HTTP ${profile.status}`);
  ratingIsBacked({ ...profile.body, facts: profile.body?.facts ?? [] }, `profile ${slug}`);
  ok('the profile marks its data origin', profile.headers.get('x-demo-data') !== null,
    'no X-Demo-Data header on a seeded read');

  const menu = await get(`/api/v1/merchants/${slug}/menu`);
  ok(`GET /api/v1/merchants/${slug}/menu`, menu.status === 200, `HTTP ${menu.status}`);
  const offerings = menu.body?.items ?? [];
  const withRating = offerings.filter((o) => o?.rating?.value != null);
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

  return finish();
}

function finish() {
  for (const n of notes) console.log(`  · ${n}`);
  if (failures.length) {
    console.log(`\n  ${failures.length} of ${checks} served-read checks FAILED:`);
    for (const f of failures.slice(0, 40)) console.log(`    - ${f}`);
    if (failures.length > 40) console.log(`    … ${failures.length - 40} more`);
    console.log('\nRESULT: FAIL');
    process.exit(1);
  }
  console.log(`\nRESULT: PASS — ${checks} served-read checks passed against ${BASE}`);
}

main().catch((err) => {
  console.log(`  ${err?.name}: ${err?.message}`);
  console.log('\nRESULT: FAIL');
  process.exit(1);
});
