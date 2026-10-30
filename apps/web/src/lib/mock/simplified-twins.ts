/**
 * The same five starter prompts typed in the OTHER script (D641 / STATUS §638).
 *
 * `lib/prompts.ts` ships the `zh-HK` half in Traditional, because that is the script a Hong Kong reader
 * is answered in (D606). What a reader TYPES is not governed by that rule: the mock plane's matcher
 * vocabulary has to cue both spellings, or a query that is a legitimate way of asking for the demo's own
 * example page comes back with nothing. These five strings are how the two parity witnesses ask that
 * question — `search-relevance.test.ts` measures `mockSearch`, `stream-route-parity.test.ts` measures the
 * shipped `POST /api/nexus/ai/stream` — and they live here so a prompt that changes script in the product
 * is caught once, not twice.
 *
 * Hand-written, not derived. Nothing on this plane converts script, and the product's own pair tables
 * (`apps/ai/nexus_ai/canonical.py`, `lexicon.py`) are blind on 周/週 and 后/後, so folding the shipped
 * strings through them would leave 週 sitting inside a "Simplified" twin and the parity claim would
 * measure one string twice. `vocabulary-spelling.test.ts` carries those four holes by name, with a leg
 * that retires the list once the tables learn them.
 *
 * The keys are the `ExamplePrompt.key` values, and the first witness asserts that the two lists still
 * hold the same keys — a new starter prompt with no twin here reddens it rather than going unmeasured.
 *
 * Said plainly for whoever wonders why no census charges these Simplified strings: `scripts/check_ui_script.mjs`
 * walks `apps/web/src/lib/*.ts` and `apps/web/src/lib/i18n/*.ts` flat, and admits what it reads by the shape of
 * its declaration (a `const zh… = {` block, or a `Record<Locale, …>` map charged only under its `zh…` keys).
 * This file is outside the walk on both counts — the directory and the shape. That is on purpose: it is not
 * copy the product answers with, and the D606 rule would be self-defeating if it forced the fixture into the
 * script it exists to contrast with. The two tests named above are its only readers, and both go red when a
 * shipped prompt stops having a twin here.
 */

export const SIMPLIFIED_TWINS: Record<string, string> = {
  friends_dinner: '帮我找附近适合朋友聚会的餐厅',
  japanese_budget: '预算 300 港币，想吃日料',
  date_weekend: '周末找一个适合情侣约会的地方',
  rainy_shoes: '我想买一双适合香港下雨天穿的鞋',
  late_gym: '帮我找一个晚上 10 点后还营业的健身房',
};
