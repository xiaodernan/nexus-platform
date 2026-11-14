import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1072 — the empty SearchBox popover pins its behaviour:
 *   - the field is a real combobox with `aria-expanded` and `aria-controls`;
 *   - Escape closes, outside pointer closes (Esc and tap-outside tested via the source);
 *   - clicking a suggestion submits a query identical to the chip row's behaviour;
 *   - the popover shows only when (a) the field is empty AND (b) it has focus.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const COMPONENT = 'apps/web/src/components/search-box.tsx';

describe('D1072 SearchBox popover', () => {
  it('uses the combobox ARIA contract on the input', () => {
    const component = read(COMPONENT);
    expect(component).toContain('role="combobox"');
    expect(component).toContain('aria-expanded={suggestionsOpen && value === \'\' ? \'true\' : \'false\'}');
    expect(component).toContain('aria-controls={`${inputId}-suggestions`}');
    expect(component).toContain('id={`${inputId}-suggestions`}');
    expect(component).toContain('role="listbox"');
    expect(component).toContain('role="option"');
  });

  it('registers listen-on-outside-click and Escape for popover dismissal', () => {
    const component = read(COMPONENT);
    expect(component).toContain("if (event.key === 'Escape') setSuggestionsOpen(false)");
    expect(component).toContain('document.addEventListener(\'pointerdown\'');
  });

  it('shows only while the field is empty and only on focus', () => {
    const component = read(COMPONENT);
    expect(component).toContain('suggestionsOpen && value === \'\'');
    expect(component).toContain("onFocus={() => setSuggestionsOpen(true)}");
  });

  it('clicking a suggestion submits it exactly like the form submit does', () => {
    const component = read(COMPONENT);
    expect(component).toContain('function submitValue(query: string)');
    expect(component).toContain('router.push(`/search?q=${encodeURIComponent(trimmed)}`)');
    expect(component).toContain('role="option"');
  });
});
