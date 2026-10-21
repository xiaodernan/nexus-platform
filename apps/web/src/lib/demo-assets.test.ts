import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  disclaimerLiteral,
  generatedArtNames,
  topLevelParts,
  literalInner,
  taxonomyTopNames,
} from './seed-vocabulary';

/**
 * Guard for the seam between the seed's *image vocabulary* and the files the web app serves.
 *
 * Seeded rows store `/demo/img/<name>.svg` in `merchants.images`, `offerings.images`,
 * `collections.cover_url` and `users.avatar_url`. The generator writes that art into
 * `data/seed/out/images/` and its README instructs a human to "Copy this directory into
 * `apps/web/public/demo/img/`". Nobody ever copied it, so every card image on the live plane
 * answered 404 while the ledger still claimed the placeholders were local. That manual step is
 * exactly the kind of step that goes missing again, so the vocabulary is now machine-checked.
 *
 * The Python sources are read as text (see `seed-vocabulary.ts`), never imported or executed.
 */

/* ------------------------------------------------------------------ loading */

/** Walk up from this file to the monorepo root; no cwd assumption, no absolute paths. */
function findRepoRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (let step = 0; step < 8; step += 1) {
    if (
      existsSync(join(dir, 'data', 'seed', 'generate.py')) &&
      existsSync(join(dir, 'apps', 'web', 'public', 'demo', 'img'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root above ${fromFile}`);
}

const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
const generatorSource = readFileSync(join(repoRoot, 'data', 'seed', 'generate.py'), 'utf8');
const poolsSource = readFileSync(join(repoRoot, 'data', 'seed', 'seed_pools.py'), 'utf8');
const assetDir = join(repoRoot, 'apps', 'web', 'public', 'demo', 'img');

const artNames = generatedArtNames(generatorSource);
const categoryArt = artNames.filter((name) => !name.startsWith('avatar-'));
const avatarArt = artNames.filter((name) => name.startsWith('avatar-'));
const topCategories = taxonomyTopNames(poolsSource);
const disclaimer = disclaimerLiteral(poolsSource);
const servedFiles = readdirSync(assetDir).sort();

/* ------------------------------------------------------------------ the seam, on the shipped files */

describe('demo placeholder art is served, not only generated', () => {
  it('has a file on disk for every name the generator writes', () => {
    const missing = artNames.filter((name) => !servedFiles.includes(name));
    expect(
      missing,
      `seeded rows point at /demo/img/{${missing.join(', ')}} but apps/web/public/demo/img/ has no such file`,
    ).toEqual([]);
  });

  it('keeps the served directory free of art the generator never writes', () => {
    const stale = servedFiles.filter((name) => !artNames.includes(name));
    expect(
      stale,
      `apps/web/public/demo/img/ carries {${stale.join(', ')}} that data/seed/generate.py does not generate`,
    ).toEqual([]);
  });

  it('has art for every top category the taxonomy can file a merchant under', () => {
    const uncovered = topCategories.filter((top) => !categoryArt.includes(`${top}.svg`));
    expect(
      uncovered,
      `CAT_TREE can produce merchants in {${uncovered.join(', ')}} whose /demo/img/<top>.svg no generator writes — those cards 404`,
    ).toEqual([]);
  });

  it('bakes the synthetic-data disclosure into the category art it serves', () => {
    // Existence is the first arm's claim; this one reads only what is on disk so a deleted file
    // reddens one case instead of crashing three.
    const undisclosed = categoryArt
      .filter((name) => servedFiles.includes(name))
      .filter((name) => !readFileSync(join(assetDir, name), 'utf8').includes(disclaimer));
    expect(
      undisclosed,
      `/demo/img/{${undisclosed.join(', ')}} carries no "${disclaimer}" text, so a reader cannot tell it is not a photo`,
    ).toEqual([]);
  });

  it('serves each avatar placeholder under its own index, not a copy of another', () => {
    const mismatched = avatarArt
      .filter((name) => servedFiles.includes(name))
      .filter((name) => {
        const index = /(\d+)/.exec(name)?.[1];
        return !readFileSync(join(assetDir, name), 'utf8').includes(`>D${index}<`);
      });
    expect(
      mismatched,
      `/demo/img/{${mismatched.join(', ')}} does not carry the D<index> label write_images() gives it`,
    ).toEqual([]);
  });

  it('serves only local placeholders — nothing hotlinks another host', () => {
    const hotlinked = servedFiles
      .filter((name) => /https?:\/\/(?!www\.w3\.org)/.test(readFileSync(join(assetDir, name), 'utf8')))
      .map((name) => name);
    expect(
      hotlinked,
      `/demo/img/{${hotlinked.join(', ')}} reaches an external host, contradicting "no real photography is hotlinked"`,
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the generated payload */

describe('the seed payload only names art that is served', () => {
  const outDir = join(repoRoot, 'data', 'seed', 'out');
  const sqlFiles = existsSync(outDir)
    ? readdirSync(outDir).filter((name) => name.endsWith('.sql')).sort()
    : [];

  // Reads the generated SQL when this machine has run the seed; the shipped-rows arm above is the
  // always-on half. Named so a green run cannot be mistaken for "the payload was checked".
  it(`resolves every /demo/img reference in ${sqlFiles.length || 'no'} generated SQL file(s)`, {
    skip: sqlFiles.length === 0,
  }, () => {
    const referenced = new Set<string>();
    for (const name of sqlFiles) {
      for (const match of readFileSync(join(outDir, name), 'utf8')
        .matchAll(/\/demo\/img\/([A-Za-z0-9._-]+)/g)) {
        referenced.add(match[1]!);
      }
    }
    const missing = [...referenced].filter((ref) => !servedFiles.includes(ref)).sort();
    expect(
      missing,
      `data/seed/out/ names /demo/img/{${missing.join(', ')}} across ${sqlFiles.length} SQL files with no such file in apps/web/public/demo/img/`,
    ).toEqual([]);
    expect(referenced.size, 'generated SQL referenced no /demo/img/ asset at all').toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ the readers themselves
 * These synthetic sources are what makes the shipped arms above falsifiable without editing a
 * tracked Python file: each one is shaped like the real generator but deliberately wrong.
 */

const FAKE_POOLS = `CAT_TREE = [
    ("restaurant", "Restaurants", "餐廳", [
        ("cantonese", "Cantonese", "粵菜"), ("dimsum", "Dim Sum", "點心"),
    ]),
    ("cafe", "Cafés (bracketed) [x]", "咖啡", [("tea", "Tea", "茶")]),
]
DISCLAIMER = "SYNTHETIC DEMO DATA - NOT REAL BUSINESSES"
`;

const FAKE_GENERATOR = `def write_images(out_dir):
    palette = {"restaurant": "#B4530F", "bar": "#4C1D53"}
    for top, colour in palette.items():
        pass
    for i, role in enumerate(["consumer", "merchant", "admin"], start=1):
        pass
`;

describe('the seed-vocabulary readers', () => {
  it('read palette keys and avatar roles out of a generator-shaped source', () => {
    expect(generatedArtNames(FAKE_GENERATOR)).toEqual([
      'restaurant.svg',
      'bar.svg',
      'avatar-1.svg',
      'avatar-2.svg',
      'avatar-3.svg',
    ]);
  });

  it('read only the top names from a taxonomy with nested leaf tuples', () => {
    expect(taxonomyTopNames(FAKE_POOLS)).toEqual(['restaurant', 'cafe']);
  });

  it('reads the disclaimer the seed stores in every alt', () => {
    expect(disclaimerLiteral(FAKE_POOLS)).toBe('SYNTHETIC DEMO DATA - NOT REAL BUSINESSES');
  });

  it('reddens the category arm when a generator drops a taxonomy category', () => {
    // Same difference the shipped arm computes, on a vocabulary missing `cafe`.
    const uncovered = taxonomyTopNames(FAKE_POOLS).filter(
      (top) => !generatedArtNames(FAKE_GENERATOR).includes(`${top}.svg`),
    );
    expect(uncovered).toEqual(['cafe']);
  });

  it('reddens the role arm when the enumerated roles change count', () => {
    const roles = topLevelParts(literalInner('["consumer", "merchant"]', '[', ']'));
    expect(roles).toEqual(['"consumer"', '"merchant"']);
    expect(generatedArtNames(FAKE_GENERATOR).filter((n) => n.startsWith('avatar-'))).toHaveLength(3);
  });

  it('survives brackets and quotes inside a literal instead of ending it early', () => {
    expect(() => literalInner('{"a": "(1)", "b": "{2}"}', '{', '}')).not.toThrow();
    expect(topLevelParts('"酒吧（x）", "next"')).toEqual(['"酒吧（x）"', '"next"']);
    expect(() => literalInner('{"unclosed": 1', '{', '}')).toThrow(/Unterminated/);
  });

  it('refuses a source that does not declare the literal it was asked for', () => {
    expect(() => generatedArtNames('def other():\n    pass\n')).toThrow();
    expect(() => disclaimerLiteral('NEXUS = 1')).toThrow(/DISCLAIMER/);
  });

  it('refuses a palette entry with no colour rather than reading half its key', () => {
    expect(() => generatedArtNames('def write_images(x):\n    palette = {"cafe"}\n')).toThrow(/no value/);
  });
});
