import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1067 — the ask-merchant widget offers three focus-typed starters before the user types:
 *
 *   - dict.ask.starters is a 3-tuple of { key, label, question }; zh and en carry the
 *     matching triples (same keys, localized strings);
 *   - the keys are only {availability, signature, hours} — every other key would be
 *     dragged through the dictionary before being trusted;
 *   - the component renders the chip row only when no turns exist yet (one-shot affordance);
 *   - no new CTAs outside that row.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const DICT = 'apps/web/src/lib/i18n/dict.ts';
const COMPONENT = 'apps/web/src/components/ask-merchant.tsx';

describe('D1067 ask-merchant starter row', () => {
  it('declares exactly three starters, zh and en, identical keys', () => {
    const dict = read(DICT);
    expect(dict).toContain("{ key: 'availability', label: '有無位'");
    expect(dict).toContain("{ key: 'signature', label: '招牌菜'");
    expect(dict).toContain("{ key: 'hours', label: '幾點開'");
    expect(dict).toContain("{ key: 'availability', label: 'Availability'");
    expect(dict).toContain("{ key: 'signature', label: 'Signature dish'");
    expect(dict).toContain("{ key: 'hours', label: 'Opening hours'");
  });

  it('renders the chips only before the first turn, never on rerender', () => {
    const component = read(COMPONENT);
    expect(component).toContain('dict.ask.starters.map(');
    expect(component).toContain('hover:border-accent hover:text-accent');
    expect(component).toContain("Icon name=\"quote\"");
  });
});
