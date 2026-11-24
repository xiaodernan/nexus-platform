import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/** D1607 — the newly added interactive cards carry teaching tooltips in both arms. */
describe('teaching tooltips on new cards', () => {
  it('layer, continuation and re-entry cards all render a title hint', () => {
    const layer = read('apps/web/src/components/layer-census-band.tsx');
    expect(layer).toContain('title={copy.cardHint.replace');
    const cont = read('apps/web/src/components/hk-continuation-rail.tsx');
    expect(cont).toContain('title={copy.cardHint.replace');
    const doors = read('apps/web/src/components/world-census-band.tsx');
    expect(doors).toContain('title={copy.doorHint}');
  });

  it('both arms supply the hint copy', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    expect(dict).toContain("cardHint: '第 {code} 層");
    expect(dict).toContain("cardHint: 'Layer {code}");
    expect(dict).toContain("cardHint: '第 {n} 章");
    expect(dict).toContain("cardHint: 'Chapter {n}");
    expect(dict).toContain("doorHint: '點一下就進這一章");
    expect(dict).toContain("doorHint: 'Open this chapter in one tap");
  });
});
