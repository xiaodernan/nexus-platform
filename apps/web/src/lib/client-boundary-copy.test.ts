import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getDict } from './i18n';

/**
 * D1522 — no client island may be handed a dictionary value that carries a function.
 *
 * D1521 shipped the reading thread with three arrow functions in the copy it passed from the
 * `/guides` SERVER component into the `ReadingThread` CLIENT island. Next.js cannot serialise a
 * function across that boundary, so it refused the payload and the whole route answered 加載失敗 —
 * while every unit test was green, because no test looked at the payload's SHAPE.
 *
 * The dictionary is full of functions on purpose (142 of them in the zh-HK arm: `curatedBy`,
 * `publishedOn`, `updatedOn`, `progress` …) and every one of them is fine where a SERVER component
 * calls it while rendering. The rule is therefore not "no functions in the dictionary" — it is
 * "no function may CROSS the boundary". This file discovers the crossings the way the product
 * makes them — a page hands `dict.<path>` to a component — and checks the value it hands.
 *
 * Discovery is textual (which page hands which path to which component); the check is a runtime
 * walk of the real dictionary object, so a new function added under a crossed path reddens here
 * rather than in a user's browser.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', 'app');
const COMPONENTS = join(HERE, '..', 'components');

const walk = (root: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
};

/**
 * Every CLIENT component in the tree, keyed by the name it exports.
 *
 * Indexed by exported name rather than by filename: the repo spells files in kebab-case and keeps
 * the console surfaces one directory deeper (`console/moderation-queue.tsx` exports
 * `ConsoleModerationQueue`), and a filename guess is how a reader starts missing crossings.
 */
const clientComponents = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const path of walk(COMPONENTS)) {
    const src = read(path);
    if (!src.includes("'use client'")) continue;
    for (const match of src.matchAll(/export function ([A-Z][A-Za-z0-9]*)/g)) {
      if (match[1]) out.set(match[1], path.split('components')[1] ?? path);
    }
  }
  return out;
};

const isClientComponent = (name: string, index: Map<string, string>): boolean =>
  index.has(name);

const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const at = (root: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], root);

/**
 * Every `<Name … prop={…a dictionary value…} …>` a page hands to a client component.
 *
 * Two spellings are discovered, because the product uses both:
 *   `copy={dict.growth.readingThread}`            — the direct form
 *   `const t = dict.world; … copy={t.worldAnswer}` — the local-alias form, which is how D1524's
 *   fourth instance slipped past the first cut of this reader
 */
const crossings = (): Array<{ page: string; component: string; prop: string; path: string }> => {
  const out: Array<{ page: string; component: string; prop: string; path: string }> = [];
  const clients = clientComponents();
  for (const page of walk(APP)) {
    const src = read(page);
    const aliases = new Map<string, string>();
    for (const match of src.matchAll(/const ([A-Za-z_][A-Za-z0-9_]*)\s*=\s*dict\.([A-Za-z0-9_.]+)/g)) {
      if (match[1] && match[2]) aliases.set(match[1], match[2]);
    }
    // A: the direct spelling. `dict.` inside the pattern is what lets the lazy skip pass over
    // the props in front of it and land on the one that carries the dictionary.
    const direct = /<([A-Z][A-Za-z0-9]*)\b[^>]*?\b([a-zA-Z]+)=\{dict\.([A-Za-z0-9_.]+)\}/g;
    for (const match of src.matchAll(direct)) {
      const [, component, prop, path] = match;
      if (component && prop && path && isClientComponent(component, clients)) {
        out.push({ page: page.split('app')[1] ?? page, component, prop, path });
      }
    }
    // B: the local-alias spelling - `const t = dict.world` then `copy={t.worldAnswer}`.
    const aliased = /<([A-Z][A-Za-z0-9]*)\b[^>]*?\b([a-zA-Z]+)=\{([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_.]+)\}/g;
    for (const match of src.matchAll(aliased)) {
      const [, component, prop, root, rest] = match;
      if (!component || !prop || !root || !rest) continue;
      const base = aliases.get(root);
      if (!base || !isClientComponent(component, clients)) continue;
      out.push({ page: page.split('app')[1] ?? page, component, prop, path: `${base}.${rest}` });
    }
  }
  return out;
};

describe('the server/client boundary carries no function', () => {
  const found = crossings();

  it('discovers the crossings it is meant to police', () => {
    // the reader must not silently pass by finding nothing.
    expect(found.length).toBeGreaterThan(3);
    expect(found.map((c) => `${c.component}.${c.prop}`)).toContain('ReadingThread.copy');
  });

  it('census the shapes this reader cannot see, so a new one cannot arrive silently', () => {
    // The reader discovers `prop={dict.path}` and `prop={alias.path}`. Two other ways to hand a
    // dictionary value across the boundary exist in JSX and are NOT discovered:
    //   `{...dict.x}` / `{...alias.x}`  — a spread
    //   a helper that forwards a subtree  — `copy={pick(dict.x)}`
    // Measured 2026-11-22 across every file under app/: ZERO of either. This leg is the tripwire:
    // the day someone writes one, it reddens and the reader grows a pattern rather than the plane
    // quietly growing a fourth broken page.
    const spreads: string[] = [];
    const helpers: string[] = [];
    for (const page of walk(APP)) {
      const src = read(page);
      for (const match of src.matchAll(/\{\.\.\.(dict\.[A-Za-z0-9_.]+|[A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        spreads.push(`${page} ${match[0]}`);
      }
      for (const match of src.matchAll(/\b([a-zA-Z]+)=\{[a-zA-Z_][A-Za-z0-9_]*\(dict\.[A-Za-z0-9_.]+\)\}/g)) {
        helpers.push(`${page} ${match[0]}`);
      }
    }
    expect(spreads, 'a spread carries a dictionary value across the boundary').toEqual([]);
    expect(helpers, 'a helper forwards a dictionary value across the boundary').toEqual([]);
  });

  it.each(found.map((c) => [`${c.component}.${c.prop} <- dict.${c.path}`, c]))(
    '%s is serialisable',
    (_label, crossing) => {
      for (const locale of ['zh-HK', 'zh-CN', 'en'] as const) {
        const value = at(getDict(locale) as unknown as Record<string, unknown>, crossing.path);
        expect(value, `${locale}: dict.${crossing.path} is missing`).toBeTruthy();
        const offenders = Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'function')
          .map(([k]) => k);
        expect(offenders, `${locale}: dict.${crossing.path} carries functions`).toEqual([]);
      }
    },
  );
});
