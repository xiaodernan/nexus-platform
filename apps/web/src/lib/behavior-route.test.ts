import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const route = readFileSync(join(repoRoot, 'apps/web/app/api/nexus/ai/admin/behavior/route.ts'), 'utf8');
const ui = readFileSync(join(repoRoot, 'apps/web/src/components/admin-analytics.tsx'), 'utf8');

describe('admin behavior BFF', () => {
  it('gates the password and serves labelled demo data offline', () => {
    expect(route).toContain("password !== '123'");
    expect(route).toContain('status: 403');
    expect(route).toContain('demoBehavior(day');
    expect(route).toContain("'/ai/v1/admin/behavior'");
    expect(route).toContain("fallback: 'live_unreachable'");
  });

  it('never stores a failed read as valid analytics data', () => {
    expect(ui).toContain('if (!res.ok)');
    expect(ui).toContain('setData(null)');
    expect(ui).toContain('data?.demo');
  });

  it('both arms carry the demo badge', () => {
    const dict = readFileSync(join(repoRoot, 'apps/web/src/lib/i18n/dict.ts'), 'utf8');
    expect(dict).toContain("demoBadge: 'Demo 資料");
    expect(dict).toContain("demoBadge: 'Demo data");
  });
});
