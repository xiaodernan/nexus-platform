/**
 * Readers for the *image vocabulary* the demo seed publishes.
 *
 * Seeded rows store `/demo/img/<name>.svg`, and the names come from three Python literals:
 * the `palette` dict and the avatar `enumerate([...])` inside `write_images()`, and `CAT_TREE`
 * / `DISCLAIMER` in `seed_pools.py`. They are parsed as text and never imported: this is a
 * TypeScript test surface reading a Python generator, and importing (or shelling out to) the
 * generator would let a broken literal take its own assertion down with it.
 *
 * The scanners track nesting and honour Python string quotes, because a category label can
 * contain a bracket (`"酒吧（x）"`) and a leaf tuple nests inside its top's list.
 */

export type PythonBracket = ['(', ')'] | ['[', ']'] | ['{', '}'];

/** Characters between the first balanced `open`…`close` pair in `text`. */
export function literalInner(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  if (start === -1) throw new Error(`No ${open} in ${text.slice(0, 40)}`);
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  throw new Error(`Unterminated ${open} literal at offset ${start} of ${text.slice(0, 40)}`);
}

/** Characters of the literal that `marker` assigns, e.g. `literalAfter(src, 'palette =', '{', '}')`. */
export function literalAfter(
  source: string,
  marker: string,
  open: string,
  close: string,
): string {
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`Literal not found: ${marker}`);
  return literalInner(source.slice(at + marker.length), open, close);
}

/** Split a literal body at its top-level commas, keeping nested elements whole. */
export function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      current += c;
      if (c === '\\') {
        current += body[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The text of a leading quoted literal, unquoted. */
export function quotedString(text: string): string {
  const value = /^["']([^"']*)["']/.exec(text)?.[1];
  if (value === undefined) throw new Error(`Expected a quoted string, got: ${text.slice(0, 40)}`);
  return value;
}

/** `<name>.svg` for every art file `write_images()` emits: one per palette key, one per avatar role. */
export function generatedArtNames(generatorSource: string): string[] {
  const at = generatorSource.indexOf('def write_images');
  if (at === -1) throw new Error('write_images() is not in the seed generator');
  const body = generatorSource.slice(at);
  const palette = topLevelParts(literalAfter(body, 'palette =', '{', '}')).map((entry) => {
    const separator = entry.indexOf(':');
    if (separator === -1) throw new Error(`palette entry has no value: ${entry.slice(0, 40)}`);
    const key = entry.slice(0, separator).trim();
    return key.startsWith('"') || key.startsWith("'") ? quotedString(key) : key;
  });
  const roles = topLevelParts(literalAfter(body, 'enumerate(', '[', ']'));
  return [
    ...palette.map((name) => `${name}.svg`),
    ...roles.map((_, index) => `avatar-${index + 1}.svg`),
  ];
}

/** The first element of each `CAT_TREE` tuple — the categories a seeded merchant can be filed under. */
export function taxonomyTopNames(poolsSource: string): string[] {
  const body = literalAfter(poolsSource, 'CAT_TREE =', '[', ']');
  return topLevelParts(body).map((topTuple) =>
    quotedString(topLevelParts(literalInner(topTuple, '(', ')'))[0] ?? ''),
  );
}

/** The disclosure string the seed stores in every `alt` and baked into every placeholder. */
export function disclaimerLiteral(poolsSource: string): string {
  const at = poolsSource.indexOf('DISCLAIMER =');
  if (at === -1) throw new Error('DISCLAIMER is not declared in seed_pools.py');
  return quotedString(poolsSource.slice(at + 'DISCLAIMER ='.length).trim());
}
