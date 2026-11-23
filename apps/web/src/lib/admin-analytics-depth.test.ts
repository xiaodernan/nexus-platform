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

  it('renders the drop-off funnel and reader profiles the payload now carries (D1569)', () => {
    const ui = read('apps/web/src/components/admin-analytics.tsx');
    expect(ui).toContain('funnel?: Array<{ step: string; sessions: number; share: number }>');
    expect(ui).toContain('profiles?: Array<{ actor: string; sessions: number; avg_depth: number }>');
    expect(ui).toContain('copy.funnelTitle');
    expect(ui).toContain('(data?.funnel ?? []).map(');
    expect(ui).toContain('(data?.profiles ?? []).map(');
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    expect(dict).toContain("funnelTitle: '行為漏斗'");
    expect(dict).toContain("funnelTitle: 'The behavior funnel'");
    const cn = read('apps/web/src/lib/i18n/dict-cn.ts');
    expect(cn).toContain("funnelTitle: '行为漏斗'");
    // The payload side actually computes the funnel and names its weakest transition.
    const events = read('apps/web/src/lib/behavior-events.ts');
    expect(events).toContain("const FUNNEL_STEPS = ['view', 'click', 'search', 'read', 'save'] as const;");
    expect(events).toContain('demo funnel weakest transition:');
  });
});
