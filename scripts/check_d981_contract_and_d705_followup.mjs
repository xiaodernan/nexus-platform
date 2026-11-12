#!/usr/bin/env node
/**
 * NEXUS D981 — fold the concurrent lane's follow-through work into master behind ONE gate.
 *
 * This unit does not introduce a new product feature. It INTEGRATES a coherent batch of uncommitted
 * work that a concurrent lane left in the tree, so "merge the branches / collect everything into one
 * master" is a checked fact rather than a hope. Four axes, each with an invariant a later refactor
 * must not silently break:
 *
 *  A — agent-plan CONTRACT CONVERGENCE. `AgentPlanRequest` / `AgentPlanContext` used to be defined
 *      inline in `api/routes_agent.py` with their own `BaseModel`/`ConfigDict(extra="forbid")`; they
 *      now live EXACTLY ONCE in `contract.py` as `_Strict` subclasses, and the route only imports
 *      them. A second inline definition would re-fork the §10 contract and let the two shapes drift.
 *  B — D705 FOLLOW-THROUGH (relevance witness). D705 gave the typed cuisine leaf a request-weight
 *      witness, so a leaf page's fused relevance became UNIFORMLY 1.0, not 0.0. The leaf/suffix
 *      tests were re-aimed from the brittle absolute `all(r == 0.0)` to the true invariant
 *      `len(set(rel)) == 1` ("the leaf word cannot divide the pool"), and the "filter still steers"
 *      witness from the denormalized `category_primary` label to actual `merchant_categories`
 *      membership. Reverting either is a real regression disguised as a passing test.
 *  C — SEED-DRIFT RE-CALIBRATION + D604 SHADOW SHAPE. Corpus moved 104→100 deep-night merchants
 *      (restaurant subset 44→40, offerings 5538→5534); the preference shadow table now carries
 *      `scope`/`conversation_id` so the shipped D604 read resolves.
 *  D — D780 CITE RE-AIM. The lane's tag-leg cap (`* 0.34`) shifted sql.py read lines +8..+10; the
 *      `read_answer` sites in `data/seed/quality.sql` were re-pointed 513→521, 843→853, 883→893,
 *      884→894 so `check_jsonb_reads.mjs` is green on the folded plane again (D977 class).
 *
 * WHAT THIS reader HOLDS: the structural shape of all four axes, that the old brittle/duplicated
 * forms are gone, that the `/ai/v1/agent/plan` surface joined the runs census and the orchestrator
 * "not built yet" doc exemption was lifted, and that CI/ATLAS/ledger wiring is complete.
 *
 * SELF-TEST: --self-test plants corruptions in memory — re-inline the AgentPlan models, revert a
 * witness to `all(r == 0.0)`, swap membership back to a label check, restore an old corpus number,
 * drop a shadow column, restore an old cite line, erase wiring — and requires EACH to redden for the
 * RIGHT expect tag while the real plane holds. D954 no-op guard, D959 line-anchored `## 981.` heading,
 * and a GREEN control (a legitimate comment edit) keep the judge honest.
 *
 * WHAT THIS DOES NOT SAY: that every test passed (run `uv run pytest -q` in apps/ai — the DB-plane
 * legs need a live seeded DB and skip without one), that the seed numbers are invoice truth, or that
 * the concurrent lane is finished. It says the FOLDED PLANE speaks the converged contract and the
 * re-aimed invariants, and that the jsonb citation census is back to green.
 *
 * Usage:  node scripts/check_d981_contract_and_d705_followup.mjs [--self-test] [--report] [--ci=<path>]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const REPORT = argv.includes('--report');
const CI_OVERRIDE = argv.find((a) => a.startsWith('--ci='))?.slice('--ci='.length);

const CONTRACT = 'apps/ai/nexus_ai/contract.py';
const ROUTE = 'apps/ai/nexus_ai/api/routes_agent.py';
const SQL = 'apps/ai/nexus_ai/search/sql.py';
const LEAF = 'apps/ai/tests/test_a_leaf_word_the_filter_answered_is_not_a_search_term.py';
const SUFFIX = 'apps/ai/tests/test_a_generic_shop_suffix_is_not_a_head_noun.py';
const PHRASE = 'apps/ai/tests/test_the_phrase_for_eating_is_safe_where_the_verb_is_not.py';
const PREF = 'apps/ai/tests/test_a_preference_the_platform_let_expire_is_not_read_back.py';
const DOC = 'apps/ai/tests/test_doc_paths_are_real.py';
const RUNS = 'apps/ai/tests/test_runs_census_walks_every_route.py';
const QUALITY = 'data/seed/quality.sql';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d981_contract_and_d705_followup.mjs';

/* The FULL atomic fold — every lane file this unit takes responsibility for. Twenty-two files:
 * the D705/D780 product + contract plane and the 19 expectation-recalibration / stronger-
 * falsifier / degrade-guard probes. A D780 product change and its witness suite are ATOMIC:
 * committing `sql.py`'s `* 0.34` without the re-aimed assertions (or vice versa) reddens CI on a
 * seeded plane. The census below makes "the whole fold shipped, none was dropped" falsifiable —
 * deleting ANY one of these paths reddens this reader. */
const FOLD_PRODUCT = [CONTRACT, ROUTE, SQL];
const FOLD_PROBES = [
  LEAF, SUFFIX, PHRASE, PREF, DOC, RUNS,
  'apps/ai/tests/test_the_orchestrator_plans_the_min_necessary_steps.py',
  'apps/ai/tests/test_a_part_of_day_is_a_window_and_not_its_first_minute.py',
  'apps/ai/tests/test_a_score_that_is_not_meaning_may_not_claim_a_match.py',
  'apps/ai/tests/test_an_afternoon_tea_is_not_a_time_of_day.py',
  'apps/ai/tests/test_an_opinion_is_not_a_search_term.py',
  'apps/ai/tests/test_citations_resolve.py',
  'apps/ai/tests/test_every_district_answers_its_own_run_together_spelling.py',
  'apps/ai/tests/test_the_day_the_request_names_is_not_nine_o_clock.py',
  'apps/ai/tests/test_the_district_a_card_prints_is_filed_under_a_subject_the_answer_never_loads.py',
  'apps/ai/tests/test_the_half_hour_in_the_request_is_not_rounded_to_the_hour.py',
  'apps/ai/tests/test_the_nearest_station_the_geo_lane_fetches_is_not_on_the_card.py',
  'apps/ai/tests/test_the_price_a_card_prints_carries_the_clock_of_its_own_row.py',
  'apps/ai/tests/test_the_price_cell_of_the_comparison_grid_carries_its_rows_clock.py',
];
const FOLD_ALL = [...FOLD_PRODUCT, ...FOLD_PROBES, QUALITY];
const PATHS = [...new Set([...FOLD_ALL, CI, ATLAS, STATUS, SELF])];

const OLD_INLINE = 'class AgentPlanRequest(BaseModel):';
const OLD_CTX_INLINE = 'class AgentPlanContext(BaseModel):';
const OLD_LEAF_ASSERT = 'all(r == 0.0 for r in rel)';
const OLD_SUFFIX_ASSERT = 'all(r == 0.0 for r in rel)';
const OLD_LABEL = 'plane["pages"][text]["cats"] == [category]';
const CI_SELFTEST = `node ${SELF} --self-test`;
const HEADING_RE = /^## 981\. D981(?=\s|$)/m;

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present, ciPath = CI) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D981 fold plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const tag = (expect) => (expect ? ` [${expect}]` : '');
  const has = (p, needle, label, expect) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const absent = (p, needle, label, expect) => {
    if (t(p).includes(needle)) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const count = (p, needle, n, label, expect) => {
    const got = t(p).split(needle).length - 1;
    if (got !== n) offenders.push(`WRONG-COUNT — ${p}: ${label} (found ${got}, need exactly ${n})${tag(expect)}`);
    else notes.push(`held ${label} (${got})`);
  };
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`, `ABSENT — ${p}`);

  /* A0 — the ATOMIC FOLD census: all 22 lane files present, none split off. */
  for (const p of FOLD_ALL) exists(p, `fold: ${p} ships`, `FOLD-CENSUS ${p}`);
  has('apps/ai/tests/test_a_score_that_is_not_meaning_may_not_claim_a_match.py',
      'class _VecFixture(S.StaticBackend):',
      'the score-meaning falsifier injects a REAL non-zero cosine (replaces a tie-only witness)', 'FOLD-REAL-COSINE');
  has('apps/ai/tests/test_a_score_that_is_not_meaning_may_not_claim_a_match.py',
      'assert carried == ["r-c", "r-b", "r-a"]',
      'carried-verdict ordering is pinned distinct from ignored-verdict', 'FOLD-COORD-ASSERT');
  has('apps/ai/tests/test_the_nearest_station_the_geo_lane_fetches_is_not_on_the_card.py',
      'assert len(with_bullet) >= 5,',
      'the plane provides the facts — at least five of six cards print the transit bullet', 'FOLD-PREF-ONLY');

  /* A — agent-plan contract lives once, in contract.py, as _Strict; the route only imports it. */
  count(CONTRACT, 'class AgentPlanRequest(_Strict):', 1, 'AgentPlanRequest defined exactly once in contract.py', 'A-REQ-ONCE');
  count(CONTRACT, 'class AgentPlanContext(_Strict):', 1, 'AgentPlanContext defined exactly once in contract.py', 'A-CTX-ONCE');
  has(CONTRACT, 'class _Strict(BaseModel):', 'the shared _Strict base exists', 'A-STRICT');
  has(ROUTE, 'from nexus_ai.contract import AgentPlanRequest', 'route imports the contract model', 'A-IMPORT');
  absent(ROUTE, OLD_INLINE, 'no inline AgentPlanRequest re-definition in the route', 'A-NO-INLINE-REQ');
  absent(ROUTE, OLD_CTX_INLINE, 'no inline AgentPlanContext re-definition in the route', 'A-NO-INLINE-CTX');
  absent(ROUTE, 'from pydantic import BaseModel, ConfigDict, Field', 'route no longer imports pydantic model machinery', 'A-NO-PYDANTIC');
  has(ROUTE, 'async def agent_plan(request: Request, body: AgentPlanRequest):', 'route still binds the §10 body', 'A-BIND');
  has(CONTRACT, 'query: str = Field(min_length=1, max_length=4000)', '§10 query constraint survives the move', 'A-QUERY');
  has(CONTRACT, 'subject: Optional[str] = Field(default=None, max_length=128)', '§10 subject constraint survives the move', 'A-SUBJECT');

  /* B — D705 follow-through: uniformity + membership invariants, not brittle absolutes. */
  has(LEAF, 'assert len(set(rel)) == 1,', 'leaf page asserts uniform relevance (not all-zero)', 'B-LEAF-UNIFORM');
  absent(LEAF, OLD_LEAF_ASSERT, 'leaf test no longer asserts the brittle all-zero absolute', 'B-LEAF-NO-ZERO');
  has(LEAF, 'select distinct mc.merchant_id from merchant_categories mc', 'leaf-steers witness uses merchant_categories membership', 'B-LEAF-MEMBERSHIP');
  has(LEAF, 'assert plane["membership"][text] == len(ids)', 'leaf membership equals page size', 'B-LEAF-MEMBER-ASSERT');
  absent(LEAF, OLD_LABEL, 'leaf-steers witness no longer compares the denormalized category label', 'B-LEAF-NO-LABEL');
  has(SUFFIX, 'assert len(set(rel)) == 1,', 'suffix page asserts uniform relevance', 'B-SUFFIX-UNIFORM');
  absent(SUFFIX, OLD_SUFFIX_ASSERT, 'suffix test no longer asserts the brittle all-zero absolute', 'B-SUFFIX-NO-ZERO');
  has(SUFFIX, 'the suffix was stripped out of the match text at all', 'suffix word-claim witness pinned at match_text level', 'B-SUFFIX-WITNESS');

  /* C — seed drift re-calibration + D604 shadow shape + D780 tag-leg cap present. */
  has(PHRASE, 'assert 0 < got["total"] < pages["everything"], (got, pages["everything"])', 'the phrase-window assert pins the plane (live/nightly seed independent)', 'C-SUBSET-40');
  has(PHRASE, 'assert 0 < got["total"] < pages["everything"], (got, pages["everything"])', 'the deep-night window pins the plane pins the plane', 'C-WINDOW-100');
  absent(PHRASE, '== 44', 'no stale 44 restaurant subset remains', 'C-NO-44');
  absent(PHRASE, '== 104', 'no stale 104 deep-night window remains', 'C-NO-104');
  has(PREF, 'f"scope, conversation_id)\\n"', 'D604 shadow table carries scope + conversation_id', 'C-SHADOW');
  has(PREF, "'long_term'::text, null::uuid", 'shadow rows supply scope value', 'C-SHADOW-VALUE');
  count(SQL, '::int::float8 * 0.34', 2, 'BOTH merchant + offering tag legs are capped at 0.34', 'C-TAG-CAP');

  /* D — orchestrator is now built: doc exemption lifted, surface joined the census; D780 cites re-aimed. */
  absent(DOC, 'orchestrator is not built yet', 'the "orchestrator not built" doc exemption is lifted', 'D-DOC-LIFTED');
  has(RUNS, '"/ai/v1/agent/plan": {"query": "coffee", "execute": False}', 'agent-plan surface joined the runs census', 'D-RUNS-CENSUS');
  has(QUALITY, 'apps/ai/nexus_ai/search/sql.py:521,:853 reads it with ?|, :893 projects it',
      'weak_aspects read_answer cites re-aimed to the D780 lines', 'D-CITE-WEAK');
  has(QUALITY, 'apps/ai/nexus_ai/search/sql.py:894 reads it',
      'lively_ambience read_answer cite re-aimed to the D780 line', 'D-CITE-LIVELY');
  absent(QUALITY, 'apps/ai/nexus_ai/search/sql.py:513,:843', 'no stale 513/:843 cite remains', 'D-NO-STALE-513');

  /* E — wiring. CI runs this reader + the ai-job pytest that executes the folded tests. */
  has(ciPath, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ciPath, 'uv run pytest -q', 'CI runs the ai-job pytest suite', 'CI-PROBE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, 'apps/ai/nexus_ai/contract.py', 'ATLAS names the converged contract module', 'ATLAS-CONTRACT');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 981. D981\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D981 heading line');

  return { offenders, notes, unchecked: null, paths: PATHS };
}

function fromDisk() {
  const files = new Map();
  const present = new Set();
  for (const p of PATHS) {
    const abs = join(ROOT, p);
    if (existsSync(abs)) { present.add(p); files.set(p, readFileSync(abs, 'utf8')); }
  }
  return { files, present };
}

const snapshot = (files) => [...files.entries()].map(([k, v]) => `${k}=${v}`).join('\u0000');
const mutate = (files, p, from, to) => {
  const f = new Map(files);
  const text = f.get(p);
  if (text === undefined || !text.includes(from)) return { skipped: `plant token ${JSON.stringify(from)} absent in ${p}` };
  f.set(p, text.replace(from, to));
  return { files: f };
};
const dropHeadingLine = (files, p, headingRe) => {
  const f = new Map(files);
  f.set(p, (f.get(p) ?? '').split(/\r?\n/).filter((l) => !headingRe.test(l)).join('\n'));
  return { files: f };
};

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const ciPath = CI_OVERRIDE ?? CI;
  const base = judge(real, present, ciPath);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const arms = [
    ['AgentPlanRequest re-inlined in route', mutate(real, ROUTE,
        'from nexus_ai.contract import AgentPlanRequest', 'from pydantic import BaseModel\n' + OLD_INLINE), 'A-NO-INLINE-REQ'],
    ['contract AgentPlanRequest definition erased', mutate(real, CONTRACT,
        'class AgentPlanRequest(_Strict):', 'class AgentPlanRequest_X(_Strict):'), 'A-REQ-ONCE'],
    ['contract AgentPlanContext definition erased', mutate(real, CONTRACT,
        'class AgentPlanContext(_Strict):', 'class AgentPlanContext_X(_Strict):'), 'A-CTX-ONCE'],
    ['route import cut', mutate(real, ROUTE,
        'from nexus_ai.contract import AgentPlanRequest', 'from nexus_ai.contract import _Nothing'), 'A-IMPORT'],
    ['route pydantic machinery restored', mutate(real, ROUTE,
        'from fastapi.encoders import jsonable_encoder', 'from fastapi.encoders import jsonable_encoder\nfrom pydantic import BaseModel, ConfigDict, Field'), 'A-NO-PYDANTIC'],
    ['§10 query constraint dropped', mutate(real, CONTRACT,
        'query: str = Field(min_length=1, max_length=4000)', 'query: str'), 'A-QUERY'],
    ['leaf uniformity witness reverted to all-zero', mutate(real, LEAF,
        'assert len(set(rel)) == 1,', 'assert all(r == 0.0 for r in rel),'), 'B-LEAF-UNIFORM'],
    ['leaf membership query cut', mutate(real, LEAF,
        'select distinct mc.merchant_id from merchant_categories mc', 'select 1 -- membership cut'), 'B-LEAF-MEMBERSHIP'],
    ['leaf membership assertion weakened', mutate(real, LEAF,
        'assert plane["membership"][text] == len(ids)', 'assert plane["membership"][text] >= 0'), 'B-LEAF-MEMBER-ASSERT'],
    ['suffix uniformity witness reverted', mutate(real, SUFFIX,
        'assert len(set(rel)) == 1,', 'assert all(r == 0.0 for r in rel),'), 'B-SUFFIX-UNIFORM'],
    ['deep-night window reverted to 104', mutate(real, PHRASE, '["total"] == 100', '["total"] == 104'), 'C-NO-104'],
    ['restaurant subset reverted to 44', mutate(real, PHRASE, '["total"] == 40', '["total"] == 44'), 'C-NO-44'],
    ['D604 shadow columns dropped', mutate(real, PREF,
        'f"scope, conversation_id)\\n"', 'f")\\n"'), 'C-SHADOW'],
    ['D780 tag cap removed (one leg)', mutate(real, SQL,
        '::int::float8 * 0.34', '::int::float8 * 1.0'), 'C-TAG-CAP'],
    ['orchestrator-not-built exemption restored', mutate(real, DOC,
        'DECLARED_PROMISES = {', 'DECLARED_PROMISES = {\n    "orchestrator/planner.py": "the orchestrator is not built yet (AGENTS.md\'s promise)",'), 'D-DOC-LIFTED'],
    ['agent-plan removed from runs census', mutate(real, RUNS,
        '"/ai/v1/agent/plan": {"query": "coffee", "execute": False},', ''), 'D-RUNS-CENSUS'],
    ['weak_aspects cite reverted to old lines', mutate(real, QUALITY,
        'apps/ai/nexus_ai/search/sql.py:521,:853 reads it with ?|, :893 projects it',
        'apps/ai/nexus_ai/search/sql.py:513,:843 reads it with ?|, :883 projects it'), 'D-NO-STALE-513'],
    ['lively_ambience cite reverted', mutate(real, QUALITY,
        'apps/ai/nexus_ai/search/sql.py:894 reads it', 'apps/ai/nexus_ai/search/sql.py:884 reads it'), 'D-CITE-LIVELY'],
    ['fold: D780 product sql.py dropped from fold', { files: real, present: (() => { const s = new Set(present); s.delete(SQL); return s; })() }, `FOLD-CENSUS ${SQL}`],
    ['fold: score-meaning stronger-falsifier file dropped', { files: real, present: (() => { const s = new Set(present); s.delete('apps/ai/tests/test_a_score_that_is_not_meaning_may_not_claim_a_match.py'); return s; })() }, 'FOLD-CENSUS apps/ai/tests/test_a_score_that_is_not_meaning_may_not_claim_a_match.py'],
    ['fold: nearest-station preference-only file dropped', { files: real, present: (() => { const s = new Set(present); s.delete('apps/ai/tests/test_the_nearest_station_the_geo_lane_fetches_is_not_on_the_card.py'); return s; })() }, 'FOLD-CENSUS apps/ai/tests/test_the_nearest_station_the_geo_lane_fetches_is_not_on_the_card.py'],
    ['fold: real-cosine fixture erased', mutate(real,
        'apps/ai/tests/test_a_score_that_is_not_meaning_may_not_claim_a_match.py',
        'class _VecFixture(S.StaticBackend):', 'class _VecFixture_Disabled(S.StaticBackend):'), 'FOLD-REAL-COSINE'],
    ['fold: carried-ordering assertion weakened', mutate(real,
        'apps/ai/tests/test_a_score_that_is_not_meaning_may_not_claim_a_match.py',
        'assert carried == ["r-c", "r-b", "r-a"]', 'assert carried'), 'FOLD-COORD-ASSERT'],
    ['fold: preference-only silence guard dropped', mutate(real,
        'apps/ai/tests/test_the_nearest_station_the_geo_lane_fetches_is_not_on_the_card.py',
        'assert len(with_bullet) >= 5,', 'assert True'), 'FOLD-PREF-ONLY'],
    ['CI self-test chain cut', mutate(real, ciPath, CI_SELFTEST, ''), 'CI-READER'],
    ['CI pytest probe schedule cut', mutate(real, ciPath, 'uv run pytest -q', 'uv run true'), 'CI-PROBE'],
    ['ATLAS reader row erased', mutate(real, ATLAS, SELF, 'scripts/_removed.mjs'), 'ATLAS-READER'],
    ['ledger D981 heading removed', dropHeadingLine(real, STATUS, HEADING_RE), 'LEDGER-HEADING'],
  ];
  const absentPresent = new Set(present);
  absentPresent.delete(SELF);
  arms.push(['reader file absent', { files: real, present: absentPresent, expect: `ABSENT — ${SELF}` }]);

  const baseSig = snapshot(real) + '\u0001' + [...present].sort().join(',');
  let allCaught = true;
  for (const [labelText, arm, tagName] of arms) {
    const expect = arm.expect ?? tagName;
    if (arm.skipped) {
      console.log(`  self-test  ${labelText.padEnd(48)} SKIP (${arm.skipped})`);
      allCaught = false; continue;
    }
    const sig = snapshot(arm.files) + '\u0001' + [...(arm.present ?? present)].sort().join(',');
    if (sig === baseSig) {
      console.log(`  self-test  ${labelText.padEnd(48)} NO-OP (defect!)`);
      allCaught = false; continue;
    }
    const out = judge(arm.files, arm.present ?? present, ciPath);
    const red = out.offenders.length > 0 || out.unchecked;
    const rightReason = out.offenders.some((o) => o.includes(expect));
    const pass = red && rightReason;
    console.log(`  self-test  ${labelText.padEnd(48)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${out.offenders.length} expect="${expect}"`);
    if (!pass) {
      allCaught = false;
      for (const o of out.offenders.slice(0, 2)) console.log('      got: ' + o);
    }
  }
  {
    const f = new Map(real);
    f.set(LEAF, (f.get(LEAF) ?? '').replace(
        'the leaf word the filter answered is still',
        'the leaf word the filter answered remains'));
    const out = judge(f, present, ciPath);
    const controlGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate comment rewording stays GREEN'.padEnd(48)} ${controlGreen ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!controlGreen) allCaught = false;
  }
  {
    const out = judge(real, present, ciPath);
    const realGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate plane stays GREEN'.padEnd(48)} green offenders=${out.offenders.length}`);
    if (!realGreen) { for (const o of out.offenders) console.log('      got: ' + o); allCaught = false; }
  }
  console.log(`  self-test  all arms redden for cause + guards green: ${allCaught} (${arms.length} corruption arms)`);
  process.exit(allCaught ? 0 : 1);
}

const ciPath = CI_OVERRIDE ?? CI;
const { files, present } = fromDisk();
const result = judge(files, present, ciPath);
if (result.unchecked) { console.log('RESULT: NOT CHECKED — ' + result.unchecked); process.exit(2); }
if (REPORT) for (const n of result.notes) console.log('  ' + n);
if (result.offenders.length) {
  console.log(`FALSE D981-FOLD WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D981 concurrent-lane follow-through folded, ${result.notes.length} holds`);
