import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** D1512 — admin analytics: hourly data is rendered and measures carry real numbers. */
const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

describe('admin analytics depth', () => {
  it('renders the hourly histogram the server already computes', () => {
    const ui = read('apps/web/src/components/admin-analytics.tsx');
    expect(ui).toContain('hourly: Array<{ hour: number; n: number }>;');
    expect(ui).toContain('copy.hourlyTitle');
    expect(ui).toContain('(data?.hourly ?? []).map(');
  });

  it('both arms carry the hourly copy', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    expect(dict).toContain("hourlyTitle: '每小時分佈'");
    expect(dict).toContain("hourlyTitle: 'Hourly distribution'");
  });
});
