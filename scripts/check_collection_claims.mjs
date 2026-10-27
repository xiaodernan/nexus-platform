#!/usr/bin/env node
/**
 * NEXUS D576 -- the claims a seeded collection makes, and the rows that support them.
 *
 * THE DEFECT. `data/seed/claim_vocabulary.json` is one file with two readers. The generator
 * (`data/seed/generate.py`) reads it to CHOOSE a collection's members and to RENDER its copy; this reader
 * reads the same file and the SHIPPED rows, and holds every claim the shipped copy makes against the
 * members the shipped copy carries. Before this reader existed, three of the four seeded collections
 * shipped copy their own members did not support: a "quiet tables" list that held a tailor and a barber,
 * a "Tai Wai" list whose copy said 大圍區 while one of its nine stops was elsewhere, and a family
 * itinerary whose route promised stages no member offered.
 *
 * WHY A SECOND READER AND NOT A TEST OF THE GENERATOR. The generator picks its members BY the claim, so
 * asking the generator whether its own members satisfy its own claim can only answer "yes" -- the filter
 * IS the answer, and the copy is rendered FROM the same values the filter used. The claim is a statement
 * about the shipped rows: `22_collections.csv` says 全線共9個站 and `06_merchants.csv` says which nine
 * shops those are. So this reader parses the SHIPPED copy back out of the vocabulary's own templates and
 * compares it with the SHIPPED rows. A change to either side is caught; a change to neither is not.
 *
 * WHAT IT READS.
 *   THE VOCABULARY -- `data/seed/claim_vocabulary.json` (`--vocab`): the collections, the phrases their
 *   copy is built from, the slots those phrases carry, and the checks those slots yield.
 *   THE ROWS -- the generated CSVs under `data/seed/out` (`--out`): 22_collections (the copy and the
 *   membership), 06_merchants (attributes, price, status), 09_locations (the primary district and the walk
 *   minutes), 05_categories + 11_merchant_categories (each member's category top), 15_availability_slots
 *   (the stages a member offers) and 04_user_preferences (the demo consumer's declared home district).
 *
 * HOW IT READS THE COPY. The copy is not searched for words. Each declared phrase becomes a REGEX built
 * mechanically -- its literal text, with every `{slot}` replaced by the capture its render kind implies --
 * and the description is split into sentences and matched against those regexes IN ORDER. A sentence the
 * vocabulary does not declare is a red; a sentence in the wrong order is a red; a slot filled with the
 * wrong number is a red that names the number and the number the rows support.
 *
 * WHAT IT DOES NOT DO, stated rather than implied.
 *   - It does not decide whether the copy is GOOD copy. It decides whether the copy is TRUE of the rows.
 *   - It does not read the running platform. The rows are the seed's own output, read as shipped.
 *   - It does not judge a collection the vocabulary does not declare -- it reds that, because a shipped
 *     collection whose copy nobody declared is a copy nobody checks.
 *   - It does not re-run the generator. A claim the generator refuses to render (an empty pool, a title
 *     word its own title does not carry) is a generator-side refusal, and the generator refuses first.
 *
 * Usage: node scripts/check_collection_claims.mjs [--out <dir>] [--vocab <file>] [--report] [--verbose]
 * Exit:  0 every claim holds; 1 a claim does not; 2 the census itself is not trustworthy.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';

const FLAGS = {
  '--out': { kind: 'value', unit: 'directory' },
  '--vocab': { kind: 'value', unit: 'file' },
  '--report': { kind: 'switch' },
  '--verbose': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) { console.log(`RESULT: NOT CHECKED — ${parsed.reason}`); process.exit(2); }
const REPORT_ONLY = Boolean(parsed.flag['--report']);
const VERBOSE = Boolean(parsed.flag['--verbose']);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = parsed.value['--out'] ? resolve(parsed.value['--out']) : join(ROOT, 'data', 'seed', 'out');
const VOCAB = parsed.value['--vocab'] ? resolve(parsed.value['--vocab']) : join(ROOT, 'data', 'seed', 'claim_vocabulary.json');
const rel = (abs) => relative(ROOT, abs).replace(/\\/g, '/');

function notChecked(reason) {
  console.log(`RESULT: NOT CHECKED — ${reason}`);
  process.exit(2);
}

/* ---------------------------------------------------------------- the vocabulary */

let vocab;
try {
  vocab = JSON.parse(readFileSync(VOCAB, 'utf8'));
} catch (e) {
  notChecked(`cannot read the claim vocabulary ${rel(VOCAB)} (${e.code ?? e.message}) — a reader with no `
    + 'vocabulary has no claims to check');
}
for (const key of ['checks', 'vocabulary', 'slots', 'phrases', 'collections']) {
  if (!vocab[key]) notChecked(`the claim vocabulary ${rel(VOCAB)} declares no \`${key}\` — it is not the file `
    + 'the generator and this reader share');
}

// A check only one side implements is a check one side can answer wrongly, so the set is closed on BOTH
// sides: the generator refuses a claim it does not know, and this reader refuses a vocabulary it does not
// know. A refusal is not a verdict -- "not checked" is not "nothing found".
const MEMBER_CHECKS = new Set([
  'district_all', 'attribute_all', 'avg_price_lt', 'kind_all', 'has_slots', 'open_on_sunday', 'weekend_slots',
]);
const SLOT_CHECKS = new Set(['kinds_exact', 'count_is', 'walk_minutes_exact', 'stage_present']);
const COLLECTION_CHECKS = new Set(['home_district']);
const KNOWN_CHECKS = new Set([...MEMBER_CHECKS, ...SLOT_CHECKS, ...COLLECTION_CHECKS]);
for (const name of Object.keys(vocab.checks)) {
  if (!KNOWN_CHECKS.has(name)) notChecked(`the claim vocabulary declares the check \`${name}\`, which this `
    + 'reader does not implement — a check one side knows and the other does not is a check one side can '
    + 'answer wrongly');
}
const RENDER_KINDS = new Set(['number', 'attribute_word', 'district', 'kind_list', 'stage_list', 'fixed']);
const DERIVE_KINDS = new Set(['max_walk_minutes', 'member_count', 'member_kinds', 'member_stages']);
for (const [name, spec] of Object.entries(vocab.slots)) {
  if (!spec || typeof spec !== 'object') notChecked(`the claim vocabulary's slot \`${name}\` is not a slot`);
  if (!RENDER_KINDS.has(spec.render)) notChecked(`the claim vocabulary's slot \`${name}\` declares the render `
    + `\`${spec.render}\`, which this reader does not implement`);
  if (spec.derive && !DERIVE_KINDS.has(spec.derive)) notChecked(`the claim vocabulary's slot \`${name}\` `
    + `declares the derivation \`${spec.derive}\`, which this reader does not implement`);
  if (!spec.check) notChecked(`the claim vocabulary's slot \`${name}\` declares no check — a slot that carries `
    + 'no claim is a slot nobody holds to the rows');
  if (!KNOWN_CHECKS.has(spec.check)) notChecked(`the claim vocabulary's slot \`${name}\` yields the check `
    + `\`${spec.check}\`, which this reader does not implement`);
}
const PHRASES = new Map();
for (const phrase of vocab.phrases) {
  if (!phrase || typeof phrase.id !== 'string' || typeof phrase.text !== 'string') {
    notChecked('the claim vocabulary holds a phrase with no id or no text');
  }
  if (PHRASES.has(phrase.id)) notChecked(`the claim vocabulary declares the phrase \`${phrase.id}\` twice`);
  PHRASES.set(phrase.id, phrase);
}
for (const phrase of vocab.phrases) {
  for (const m of phrase.text.matchAll(/\{(\w+)\}/g)) {
    if (!vocab.slots[m[1]]) notChecked(`the phrase \`${phrase.id}\` names the slot \`${m[1]}\`, which the `
      + "vocabulary's slot table does not declare");
  }
}
if (!vocab.collections.length) {
  notChecked('the claim vocabulary declares no collection — a population of zero claims has cleared nothing');
}
if (!vocab.disclaimer) notChecked('the claim vocabulary declares no disclaimer — the shipped copy ends with '
  + 'one and the reader has to know which words that is');

const DISTRICTS = vocab.vocabulary.districts ?? [];
const KINDS = vocab.vocabulary.kinds ?? [];
const ATTRIBUTES = vocab.vocabulary.attributes ?? [];
const BANDS = vocab.vocabulary.bands ?? [];
const STAGES = vocab.vocabulary.stages ?? [];
const districtBySlug = new Map(DISTRICTS.map((d) => [d.slug, d]));
const districtByEn = new Map(DISTRICTS.map((d) => [d.en, d]));
const kindByKey = new Map(KINDS.map((k) => [k.key, k]));
const kindByZh = new Map(KINDS.map((k) => [k.zh, k]));
const attributeByKey = new Map(ATTRIBUTES.map((a) => [a.key, a]));
const stageByKey = new Map(STAGES.map((s) => [s.key, s]));
const stageByZh = new Map(STAGES.map((s) => [s.zh, s]));

/* ---------------------------------------------------------------- the rows */

const CSVS = {
  collections: '22_collections.csv',
  merchants: '06_merchants.csv',
  locations: '09_locations.csv',
  categories: '05_categories.csv',
  merchantCategories: '11_merchant_categories.csv',
  slots: '15_availability_slots.csv',
  preferences: '04_user_preferences.csv',
};
for (const [what, file] of Object.entries(CSVS)) {
  if (!existsSync(join(OUT, file))) {
    notChecked(`the ${what} rows are absent: ${rel(join(OUT, file))} is not there — a plane this reader cannot `
      + 'see is not a plane whose claims hold');
  }
}

/** RFC4180-ish: quoted fields, doubled quotes, embedded newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function readCsv(abs) {
  const rows = parseCsv(readFileSync(abs, 'utf8'));
  let head = 0;
  while (head < rows.length && rows[head].length === 1 && rows[head][0].trimStart().startsWith('#')) head += 1;
  if (head >= rows.length) return { header: [], rows: [] };
  const header = rows[head];
  const out = [];
  for (let i = head + 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.length === 1 && r[0] === '') continue;
    const obj = {};
    for (let j = 0; j < header.length; j += 1) {
      const v = j < r.length ? r[j] : '';
      obj[header[j]] = v === '\\N' ? null : v;
    }
    out.push(obj);
  }
  return { header, rows: out };
}

const merchantRows = readCsv(join(OUT, CSVS.merchants)).rows;
const merchants = new Map(merchantRows.map((r) => [r.id, r]));
const primaryLocation = new Map();
for (const r of readCsv(join(OUT, CSVS.locations)).rows) {
  if (r.is_primary === 'true') primaryLocation.set(r.merchant_id, r);
}
const categories = new Map(readCsv(join(OUT, CSVS.categories)).rows.map((r) => [r.id, r]));
const merchantCategories = new Map();
for (const r of readCsv(join(OUT, CSVS.merchantCategories)).rows) {
  if (!merchantCategories.has(r.merchant_id)) merchantCategories.set(r.merchant_id, []);
  merchantCategories.get(r.merchant_id).push(r.category_id);
}

/** A slot's local weekday (0 = Sunday) and its local wall-clock time. */
function parseSlot(startsAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(startsAt ?? ''));
  if (!m) return null;
  return {
    weekday: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay(),
    hhmm: `${m[4]}:${m[5]}`,
  };
}
const slotsByMerchant = new Map();
for (const r of readCsv(join(OUT, CSVS.slots)).rows) {
  const parsed = parseSlot(r.starts_at);
  if (!parsed) continue;
  if (!slotsByMerchant.has(r.merchant_id)) slotsByMerchant.set(r.merchant_id, []);
  slotsByMerchant.get(r.merchant_id).push(parsed);
}
const preferences = readCsv(join(OUT, CSVS.preferences)).rows;
const collectionRows = readCsv(join(OUT, CSVS.collections)).rows;

if (collectionRows.length === 0) {
  notChecked('the shipped plane carries no collection at all — a census with no collection to judge has '
    + 'cleared nothing');
}

/* ---------------------------------------------------------------- the derived facts */

const attrsOf = (id) => {
  const raw = merchants.get(id)?.attributes;
  if (!raw) return {};
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
};

const kindOf = (id) => {
  for (const cid of merchantCategories.get(id) ?? []) {
    let cur = categories.get(cid);
    let hops = 0;
    while (cur && hops < 8) {
      if (!cur.parent_id) return cur.slug;
      cur = categories.get(cur.parent_id);
      hops += 1;
    }
  }
  return null;
};

const districtOf = (id) => {
  const loc = primaryLocation.get(id);
  if (!loc || !loc.district) return null;
  return districtByEn.get(loc.district)?.slug ?? null;
};

const walkMinutesOf = (id) => {
  const raw = primaryLocation.get(id)?.mtr_walk_min;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const slotsOf = (id) => slotsByMerchant.get(id) ?? [];

const priceOf = (id) => {
  const raw = merchants.get(id)?.avg_price_hkd;
  const n = Number(raw);
  return raw === null || raw === undefined || raw === '' || !Number.isFinite(n) ? null : n;
};

/** The demo consumer's declared home district, as a vocabulary slug. */
function consumerHomeDistrict(userId) {
  const rows = preferences.filter((r) => r.user_id === userId && r.key === 'home_district');
  if (rows.length !== 1) return null;
  let value;
  try { value = JSON.parse(rows[0].value); } catch { return null; }
  const en = value && typeof value === 'object' ? value.value : null;
  return en ? districtByEn.get(en)?.slug ?? null : null;
}

/** Whether ONE member satisfies ONE membership claim. */
function memberSatisfies(id, claim) {
  const check = claim.check;
  const value = claim.value;
  if (check === 'district_all') return districtOf(id) === value;
  if (check === 'attribute_all') return attrsOf(id)[value] === true;
  if (check === 'avg_price_lt') { const p = priceOf(id); return p !== null && p < value; }
  if (check === 'kind_all') { const k = kindOf(id); return k !== null && Array.isArray(value) && value.includes(k); }
  if (check === 'has_slots') return slotsOf(id).length > 0;
  if (check === 'open_on_sunday') return slotsOf(id).some((s) => s.weekday === 6);
  if (check === 'weekend_slots') {
    const days = new Set(slotsOf(id).map((s) => s.weekday));
    return days.has(5) && days.has(6);
  }
  return null; // an unknown check never reaches here: the vocabulary was closed above
}

/** Whether the members (or the consumer) support what a title claims. */
function claimHolds(claim, memberIds, authorId) {
  if (!MEMBER_CHECKS.has(claim.check) && !COLLECTION_CHECKS.has(claim.check)) return null;
  if (COLLECTION_CHECKS.has(claim.check)) {
    const home = consumerHomeDistrict(authorId);
    return home !== null && home === claim.value;
  }
  return memberIds.every((id) => memberSatisfies(id, claim) === true);
}

/* ---------------------------------------------------------------- the phrases */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The regex a phrase becomes, derived from its text and the slot table.
 *
 * A number slot captures digits; every other slot captures text that stops at a full stop, so a capture
 * can never run past the sentence it belongs to. The whole sentence is anchored, so a sentence carrying
 * extra words does not match the template it claims to be.
 */
function phraseRegex(phrase) {
  const parts = phrase.text.split(/\{(\w+)\}/);
  let re = '^';
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) { re += escapeRe(parts[i]); continue; }
    const spec = vocab.slots[parts[i]];
    re += spec.render === 'number' ? '(\\d+(?:\\.\\d+)?)' : '([^。]+?)';
  }
  return new RegExp(`${re}$`);
}

/** The words of a `A、B同C` list. */
function splitZhList(text) {
  return String(text).split('、').flatMap((part) => part.split('同')).map((w) => w.trim()).filter(Boolean);
}

/* ---------------------------------------------------------------- the census */

const failures = [];
let claimsChecked = 0;
let memberCount = 0;
let sentenceCount = 0;
const fail = (slug, message) => failures.push(`${slug} — ${message}`);

const shippedBySlug = new Map(collectionRows.map((r) => [r.slug, r]));

for (const entry of vocab.collections) {
  const slug = entry.slug;
  const row = shippedBySlug.get(slug);
  if (!row) {
    fail(slug, 'the claim vocabulary declares it, but the shipped plane carries no such collection');
    continue;
  }

  // The shell of the collection: the kind, the titles and the cover are declared, so a shipped copy that
  // is not the declared one is a copy this reader cannot judge -- and it says so rather than passing.
  if (row.kind !== entry.kind) {
    fail(slug, `the shipped kind is \`${row.kind}\` but the vocabulary declares \`${entry.kind}\``);
  }
  if (row.title !== entry.title) {
    fail(slug, `the shipped title is \`${row.title}\` but the vocabulary declares \`${entry.title}\``);
  }
  if (row.title_zh !== entry.title_zh) {
    fail(slug, `the shipped title_zh is \`${row.title_zh}\` but the vocabulary declares \`${entry.title_zh}\``);
  }
  const cover = `/demo/img/${entry.cover}.svg`;
  if (row.cover_url !== cover) {
    fail(slug, `the shipped cover is \`${row.cover_url}\` but the vocabulary declares \`${cover}\``);
  }

  // The membership: the list the copy describes.
  let items;
  try { items = JSON.parse(row.items ?? '[]'); } catch { items = null; }
  if (!Array.isArray(items)) {
    fail(slug, 'the shipped items are not a list, so the copy describes a membership this reader cannot read');
    continue;
  }
  if (items.length === 0) {
    fail(slug, 'the shipped collection holds no member, so its copy claims things about nothing');
    continue;
  }
  const itemIds = [];
  for (const item of items) {
    if (item?.subject_type !== 'merchant') {
      fail(slug, `the list holds an item that is not a merchant (\`${item?.subject_type}\`)`);
      continue;
    }
    const id = item.subject_id;
    if (!merchants.has(id)) {
      fail(slug, `the list cites the merchant \`${id}\`, which the shipped plane does not contain`);
      continue;
    }
    itemIds.push(id);
  }
  const distinctIds = [...new Set(itemIds)];
  memberCount += distinctIds.length;

  // The membership CLAIMS: every declared claim, asked of every member.
  for (const claim of entry.members?.claims ?? []) {
    for (const id of distinctIds) {
      claimsChecked += 1;
      const ok = memberSatisfies(id, claim);
      const name = merchants.get(id)?.display_name ?? id;
      if (ok === null) {
        fail(slug, `the claim \`${claim.check}\` is not one this reader can ask of a member`);
      } else if (!ok) {
        const why = {
          district_all: `is not in ${districtBySlug.get(claim.value)?.en ?? claim.value}`,
          attribute_all: `does not carry the attribute \`${claim.value}\``,
          avg_price_lt: `has an average price of ${priceOf(id)}, which is not below ${claim.value}`,
          kind_all: `is a \`${kindOf(id)}\`, which is not one of ${JSON.stringify(claim.value)}`,
          has_slots: 'has no availability slot',
          open_on_sunday: 'has no slot on a Sunday',
          weekend_slots: 'has no slot on both a Saturday and a Sunday',
        }[claim.check] ?? `does not satisfy \`${claim.check}\``;
        fail(slug, `the member "${name}" ${why}, so the copy's claim \`${claim.check}\` is not true of the list`);
      }
    }
  }

  // The TITLE claims: the word that carries the claim, and the claim itself.
  for (const claim of entry.title_claims ?? []) {
    claimsChecked += 1;
    const zh = claim.zh;
    const en = claim.en;
    if (!zh || !en) {
      fail(slug, `the title claims \`${claim.check}\` with no word in it — a title nobody can check says nothing`);
      continue;
    }
    if (!row.title_zh.includes(zh) || !row.title.includes(en)) {
      fail(slug, `the title claims \`${claim.check}\` in the words ${zh}/${en}, but the title `
        + `\`${row.title_zh}\` / \`${row.title}\` does not carry them`);
      continue;
    }
    if (claim.check === 'district_all') {
      const d = districtBySlug.get(claim.value);
      if (!d) { fail(slug, `the title claims the district \`${claim.value}\`, which the vocabulary does not declare`); continue; }
      if (zh !== d.zh || en !== d.en) {
        fail(slug, `the title spells the district \`${claim.value}\` as ${zh}/${en}, but the vocabulary names it `
          + `${d.zh}/${d.en}`);
        continue;
      }
    } else if (claim.check === 'attribute_all') {
      const a = attributeByKey.get(claim.value);
      if (!a) { fail(slug, `the title claims the attribute \`${claim.value}\`, which the vocabulary does not declare`); continue; }
      if (zh !== a.zh || en !== a.en) {
        fail(slug, `the title spells the attribute \`${claim.value}\` as ${zh}/${en}, but the vocabulary names it `
          + `${a.zh}/${a.en}`);
        continue;
      }
    } else if (claim.check === 'avg_price_lt') {
      if (!String(claim.value).includes(claim.value) || !zh.includes(String(claim.value)) || !en.includes(String(claim.value))) {
        fail(slug, `the title claims a price below ${claim.value}, but its words ${zh}/${en} do not carry the number`);
        continue;
      }
    }
    const holds = claimHolds(claim, distinctIds, row.author_id);
    if (holds === null) {
      fail(slug, `the title claims \`${claim.check}\`, which is not a check this reader can hold`);
    } else if (!holds) {
      const why = claim.check === 'home_district'
        ? `the demo consumer's declared home district is not \`${claim.value}\``
        : 'its own members do not support it';
      fail(slug, `the title claims \`${claim.check}\`=${JSON.stringify(claim.value ?? null)}, but ${why}`);
    }
  }

  // The COPY: the description is parsed back out of the declared templates.
  const desc = row.description ?? '';
  const disclaimer = vocab.disclaimer;
  if (!desc.endsWith(` ${disclaimer}`)) {
    fail(slug, `the shipped copy does not end with the declared disclaimer "${disclaimer}"`);
    continue;
  }
  const body = desc.slice(0, desc.length - disclaimer.length - 1);
  const sentences = body.split('。').filter((s) => s.length > 0).map((s) => `${s}。`);
  sentenceCount += sentences.length;
  const bodyPhrases = entry.body ?? [];
  if (sentences.length !== bodyPhrases.length) {
    fail(slug, `the shipped copy carries ${sentences.length} sentence(s) but the vocabulary declares `
      + `${bodyPhrases.length} phrase(s)`);
  }
  const captured = [];
  for (let i = 0; i < Math.min(sentences.length, bodyPhrases.length); i += 1) {
    const phrase = PHRASES.get(bodyPhrases[i]);
    if (!phrase) {
      fail(slug, `the vocabulary names the phrase \`${bodyPhrases[i]}\`, which its own phrase table does not declare`);
      break;
    }
    const m = phraseRegex(phrase).exec(sentences[i]);
    if (!m) {
      fail(slug, `the shipped sentence ${i + 1} is "${sentences[i]}", which is not the declared phrase `
        + `\`${phrase.id}\` ("${phrase.text}")`);
      break;
    }
    captured.push({ phrase, values: m.slice(1) });
  }

  // The DERIVED values: what the members themselves support, recomputed from the shipped rows.
  const derived = {
    member_count: distinctIds.length,
    max_walk_minutes: distinctIds.length ? Math.max(...distinctIds.map(walkMinutesOf).filter((n) => n !== null)) : null,
    member_kinds: KINDS.map((k) => k.key).filter((key) => distinctIds.some((id) => kindOf(id) === key)),
    member_stages: STAGES.filter((stage) => stageOffered(stage, distinctIds)).map((s) => s.key),
  };
  if (derived.max_walk_minutes === null) {
    fail(slug, 'no member carries a walk distance, so the copy cannot claim one');
  }

  // Each slot's value, as the copy states it and as the rows support it.
  for (const { phrase, values } of captured) {
    const slots = [...phrase.text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (let i = 0; i < slots.length; i += 1) {
      const name = slots[i];
      const spec = vocab.slots[name];
      const stated = values[i];
      claimsChecked += 1;
      const problem = slotProblem(name, spec, stated, distinctIds, derived);
      if (problem) fail(slug, `the sentence "${phrase.id}" claims ${problem}`);
    }
  }

  if (VERBOSE) {
    console.log(`  ${slug} — ${distinctIds.length} distinct member(s), kinds `
      + `${JSON.stringify(derived.member_kinds)}, stages ${JSON.stringify(derived.member_stages)}, `
      + `max walk ${derived.max_walk_minutes}`);
  }
}

/** Whether one stage is offered by at least one member's own slots. */
function stageOffered(stage, memberIds) {
  const kinds = stage.kind_in ?? [];
  let window = null;
  if (stage.band) {
    window = BANDS.find((b) => b.key === stage.band) ?? null;
    if (!window) return false;
  }
  for (const id of memberIds) {
    if (kinds.length && !kinds.includes(kindOf(id))) continue;
    for (const s of slotsOf(id)) {
      if (!window) return true;
      if (window.from <= s.hhmm && s.hhmm <= window.to) return true;
    }
  }
  return false;
}

/**
 * One slot's problem, or null when the copy's value and the rows agree.
 *
 * The slot's declared `check` says what the copy claims; the slot's declared `derive` says where the
 * number came from. Both are held: the copy must state the derived value AND the members must satisfy
 * the claim it states.
 */
function slotProblem(name, spec, stated, memberIds, derived) {
  const kind = spec.render;
  if (kind === 'number') {
    const n = Number(stated);
    if (!Number.isFinite(n)) return `a number this reader cannot read ("${stated}")`;
    if (spec.derive === 'member_count' && n !== derived.member_count) {
      return `${n}, but the list holds ${derived.member_count} distinct member(s)`;
    }
    if (spec.derive === 'max_walk_minutes' && n !== derived.max_walk_minutes) {
      return `${n} minutes, but the members' own maximum is ${derived.max_walk_minutes}`;
    }
    if (spec.check === 'avg_price_lt') {
      const over = memberIds.filter((id) => priceOf(id) === null || priceOf(id) >= n);
      if (over.length) {
        const names = over.slice(0, 3).map((id) => `"${merchants.get(id)?.display_name ?? id}"`).join(', ');
        return `a price below ${n}, but ${over.length} of ${memberIds.length} member(s) are at or above it `
          + `(${names}${over.length > 3 ? ', …' : ''})`;
      }
    }
    return null;
  }
  if (kind === 'fixed') {
    if (stated !== spec.value) return `"${stated}", but the vocabulary's fixed word is "${spec.value}"`;
    if (spec.check === 'weekend_slots') {
      const missing = memberIds.filter((id) => {
        const days = new Set(slotsOf(id).map((s) => s.weekday));
        return !(days.has(5) && days.has(6));
      });
      if (missing.length) {
        const names = missing.slice(0, 3).map((id) => `"${merchants.get(id)?.display_name ?? id}"`).join(', ');
        return `a weekend, but ${missing.length} of ${memberIds.length} member(s) have no slot on both a `
          + `Saturday and a Sunday (${names}${missing.length > 3 ? ', …' : ''})`;
      }
    }
    return null;
  }
  if (kind === 'attribute_word') {
    const attr = attributeByKey.get(spec.value);
    if (!attr) return `an attribute the vocabulary does not declare ("${spec.value}")`;
    if (stated !== attr.zh) return `"${stated}", but the vocabulary spells \`${spec.value}\` as "${attr.zh}"`;
    const missing = memberIds.filter((id) => attrsOf(id)[spec.value] !== true);
    if (missing.length) {
      const names = missing.slice(0, 3).map((id) => `"${merchants.get(id)?.display_name ?? id}"`).join(', ');
      return `${attr.zh}, but ${missing.length} of ${memberIds.length} member(s) do not carry \`${spec.value}\` `
        + `(${names}${missing.length > 3 ? ', …' : ''})`;
    }
    return null;
  }
  if (kind === 'district') {
    const d = [...districtBySlug.values()].find((x) => x.zh === stated);
    if (!d) return `the district "${stated}", which the vocabulary does not declare`;
    if (spec.check === 'district_all') {
      const elsewhere = memberIds.filter((id) => districtOf(id) !== d.slug);
      if (elsewhere.length) {
        const names = elsewhere.slice(0, 3).map((id) => `"${merchants.get(id)?.display_name ?? id}"`).join(', ');
        return `${d.zh}, but ${elsewhere.length} of ${memberIds.length} member(s) are elsewhere (${names}`
          + `${elsewhere.length > 3 ? ', …' : ''})`;
      }
    }
    return null;
  }
  if (kind === 'kind_list') {
    const words = splitZhList(stated);
    const keys = [];
    for (const word of words) {
      const k = kindByZh.get(word);
      if (!k) return `the kind "${word}", which the vocabulary does not declare`;
      keys.push(k.key);
    }
    if (spec.check === 'kinds_exact') {
      const want = derived.member_kinds;
      const missing = want.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !want.includes(k));
      if (missing.length || extra.length) {
        return `${stated}, but the members are ${want.join('、')} — `
          + `${missing.length ? `missing ${missing.join('、')}` : ''}`
          + `${missing.length && extra.length ? ' and ' : ''}${extra.length ? `named ${extra.join('、')} which no member is` : ''}`;
      }
    }
    return null;
  }
  if (kind === 'stage_list') {
    const words = splitZhList(stated);
    const keys = [];
    for (const word of words) {
      const s = stageByZh.get(word);
      if (!s) return `the stage "${word}", which the vocabulary does not declare`;
      keys.push(s.key);
    }
    for (const key of keys) {
      const stage = stageByKey.get(key);
      if (!stageOffered(stage, memberIds)) {
        return `the stage "${stage.zh}", which no member's own slots offer`;
      }
    }
    if (spec.derive === 'member_stages') {
      const want = derived.member_stages;
      const missing = want.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !want.includes(k));
      if (missing.length || extra.length) {
        return `${stated}, but the members offer ${want.join('、')}`
          + `${missing.length ? ` — missing ${missing.join('、')}` : ''}`
          + `${extra.length ? ` — naming ${extra.join('、')} which no member offers` : ''}`;
      }
    }
    return null;
  }
  return `a render kind this reader does not understand ("${kind}")`;
}

/* ---------------------------------------------------------------- the collections nobody declared */

for (const row of collectionRows) {
  if (!vocab.collections.some((e) => e.slug === row.slug)) {
    fail(row.slug, 'the shipped plane carries it, but no claim in the vocabulary declares it — a copy nobody '
      + 'declares is a copy nobody checks');
  }
}

/* ---------------------------------------------------------------- the verdict */

const declared = vocab.collections.length;
console.log('NEXUS — the claims a seeded collection makes, and the rows that support them');
console.log(`  plane read            ${rel(OUT)}`);
console.log(`  vocabulary            ${rel(VOCAB)}`);
console.log(`  collections           ${declared} declared, ${collectionRows.length} shipped`);
console.log(`  members               ${memberCount} distinct member(s) over the collections that were read`);
console.log(`  copy                  ${sentenceCount} sentence(s) parsed back out of ${PHRASES.size} template(s)`);
console.log(`  claims checked        ${claimsChecked}`);

if (claimsChecked === 0) {
  notChecked('no claim was checked — a census that asked nothing has cleared nothing');
}

if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log(`\nRESULT: FAIL — ${failures.length} claim(s) the shipped copy makes are not supported by the `
    + 'shipped rows');
  process.exit(REPORT_ONLY ? 0 : 1);
}
console.log('\nRESULT: PASS — every claim the shipped collections make is supported by the shipped rows');
