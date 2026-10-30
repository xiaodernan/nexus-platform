import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { trustLabels } from './i18n/trust-labels';

/**
 * The compare grid's row names are a vocabulary in two places, and nothing joined them.
 *
 * `CompareTable` prints `labels.rowLabels?.[row.attribute] ?? row.attribute` — so an attribute the
 * label map does not carry is not an error anywhere: it renders the raw key to the reader, in a
 * Chinese interface, as `availability`. The AI decides which rows exist (`_compare_rows` in
 * `apps/ai/nexus_ai/api/routes_discover.py`), the web decides what they are called, and until this
 * test the only thing keeping the two in step was that someone had typed both lists by hand.
 *
 * This is the shape the project keeps meeting (D488 and its relatives): one fact, two readers, no
 * witness. So the witness reads the AI's row list as TEXT — never by importing it, which would let a
 * broken list satisfy its own assertion — and requires it to be exactly the label map's keys, in
 * both locales, with no label that is merely the key spelled again.
 */

function findRepoRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (let step = 0; step < 8; step += 1) {
    if (existsSync(join(dir, 'apps', 'ai', 'nexus_ai', 'api', 'routes_discover.py'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root above ${fromFile}`);
}

const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
const discoverSource = readFileSync(join(repoRoot, 'apps', 'ai', 'nexus_ai', 'api', 'routes_discover.py'), 'utf8');

/**
 * The attributes `_compare_rows` emits, in the order it emits them. The extraction refuses rather
 * than returning an empty list: a test that silently found no rows would pass against any change.
 */
function compareAttributesIn(source: string): string[] {
  const loop = /for attribute, cells in \(([\s\S]*?)\):/.exec(source);
  if (!loop) throw new Error('_compare_rows no longer holds a `for attribute, cells in (...)` loop, so this test cannot read the rows it is meant to pin');
  const attributes = [...(loop[1] as string).matchAll(/\("([a-z_]+)",\s*\w+\)/g)].map((m) => m[1] as string);
  if (attributes.length === 0) throw new Error('the compare loop was found but names no ("attribute", cells) pairs, so this test measured nothing');
  return attributes;
}

const emitted = compareAttributesIn(discoverSource);
const zh = trustLabels('zh-HK').rowLabels;
const en = trustLabels('en').rowLabels;

describe('the compare grid names every row the AI emits', () => {
  it('reads the AI row list (the witness checks its own reading)', () => {
    // Six today (price, rating, category, district, open_state, distance). Asserting the floor, not
    // the number, so adding a row is a labelled change rather than a silently passing test.
    expect(emitted.length).toBeGreaterThanOrEqual(6);
    expect(emitted).toContain('open_state');
    expect(new Set(emitted).size).toBe(emitted.length);
  });

  it('carries a label for every emitted attribute, in both locales', () => {
    const missing = {
      'zh-HK': emitted.filter((attribute) => !(attribute in zh)),
      en: emitted.filter((attribute) => !(attribute in en)),
    };
    expect(
      missing,
      `CompareTable falls back to the raw attribute key, so a reader sees the identifier instead of ` +
        `a row name:\n${JSON.stringify(missing, null, 2)}`,
    ).toEqual({ 'zh-HK': [], en: [] });
  });

  it('labels no row the AI does not emit', () => {
    const extra = {
      'zh-HK': Object.keys(zh).filter((attribute) => !emitted.includes(attribute)),
      en: Object.keys(en).filter((attribute) => !emitted.includes(attribute)),
    };
    expect(
      extra,
      `a label with no row is a name nothing prints, and it hides the day the AI renames a row:\n${JSON.stringify(extra, null, 2)}`,
    ).toEqual({ 'zh-HK': [], en: [] });
  });

  it('gives each row a real name rather than the key spelled again', () => {
    // The defect the PLAN item described: the grid printed `open_state`. The test is "a label must
    // not look like an identifier", not "a label must differ from its key" — an English row really is
    // called "Price", and a rule that forbade that would redden on correct copy. What no locale may
    // do is hand the reader a snake_case attribute name.
    const identifiers = [...Object.entries(zh), ...Object.entries(en)]
      .filter(([, label]) => /^[a-z][a-z_]*$/.test(label))
      .map(([key, label]) => `${key} -> ${label}`);
    expect(identifiers, `these rows are labelled with an identifier:\n${identifiers.join('\n')}`).toEqual([]);
  });

  it('keeps the two locales in step', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });
});
