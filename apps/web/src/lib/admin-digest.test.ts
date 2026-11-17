/**
 * D1285 — the digest island is fail-closed by construction.
 *
 * The console renders the counters either way; this island only ADDS the model's phrasing.
 * These pins read the source the way the repo's island pins do.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const ISLAND = 'apps/web/src/components/admin-digest.tsx';
const PAGE = 'apps/web/app/admin/system/page.tsx';

describe('admin-digest island', () => {
  const island = readFileSync(join(repoRoot, ISLAND), 'utf8');

  it('is a client component with one mount effect, no timers, no storage', () => {
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).toContain('useEffect');
    expect(island).not.toContain('setInterval');
    expect(island).not.toContain('setTimeout');
    expect(island).not.toContain('localStorage');
    expect(island).not.toContain('sessionStorage');
  });

  it('its single network call is a POST to the gated BFF, abortable', () => {
    expect(island).toContain("fetch('/api/nexus/admin/digest'");
    expect(island).toContain("method: 'POST'");
    expect(island).toContain('AbortController');
    expect(island).not.toContain('retry(');
  });

  it('on any failure it renders nothing — the counters alone stand', () => {
    expect(island).toContain("if (phase.kind === 'gone') return null;");
    expect(island).toContain('degraded !== true');
  });
});

describe('/admin/system mounts the digest under the events section, §68-gated', () => {
  const page = readFileSync(join(repoRoot, PAGE), 'utf8');

  it('renders AdminDenied before any data read, then mounts the island once with dict labels', () => {
    expect(page).toContain('AdminDenied');
    expect(page).toContain('<AdminDigest');
    expect(page).toContain('labels={dict.console.adminConsole.digest}');
    expect((page.match(/<AdminDigest/g) ?? []).length).toBe(1);
  });
});
