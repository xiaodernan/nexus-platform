import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * D1271 — pins for the operator-facing REAL-TRACE panels on /insights and /command,
 * backed by the committed evidence file (docs/evidence/user-journey-2026-11-16.md).
 * The module parses rows from the markdown at build time; no network, no env, no island.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const TRACE_MODULE = 'apps/web/src/lib/real-trace.ts';
const EVIDENCE = 'docs/evidence/user-journey-2026-11-16.md';
const INSIGHTS = 'apps/web/app/insights/page.tsx';
const COMMAND = 'apps/web/src/components/command-console.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1271 the evidence made visible', () => {
  it('the evidence file ships twelve completed journeys', () => {
    const text = read(EVIDENCE);
    const matches = text.match(/outcome: \*\*completed\*\*/g) ?? [];
    expect(matches.length).toBe(12);
    expect(text).toContain('focused-search');
    expect(text).toContain('wheel-scroller');
    expect(text).toContain('impatient-close');
    expect(text).toContain('closed-but-curious');
  });

  it('the parser rethrows the shape of the markdown into typed rows', async () => {
    const { realTrace } = await import('@/lib/real-trace');
    const { rows, totals } = realTrace();
    expect(rows.length).toBe(12);
    expect(totals.completed).toBe(12);
    expect(totals.crashed).toBe(0);
    expect(totals.totalMs).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.outcome).toBe('completed');
      expect(row.name.length).toBeGreaterThan(0);
      expect(row.duration_ms).toBeGreaterThan(0);
    }
  });

  it('/insights carries the REAL-TRACE panel and the dict literals both arms', () => {
    const page = read(INSIGHTS);
    expect(page).toContain('id="insights-real"');
    expect(page).toContain('{t.realTraceTitle}');
    expect(page).toContain('{trace.rows.map');
    const dict = read(DICT);
    expect(dict).toContain("realTraceTitle: 'REAL-TRACE · 真實旅程'");
    expect(dict).toContain("realTraceTitle: 'REAL-TRACE · Real journeys'");
  });

  it('/command carries the REAL-TRACE panel; client is fed by the server', () => {
    const page = read(INSIGHTS); // reference read for format drift guard
    expect(page).toContain('realTrace');
    const consoleSrc = read(COMMAND);
    expect(consoleSrc).toContain('id="cmd-realtrace"');
    expect(consoleSrc).toContain('copy.realTraceTitle');
    expect(consoleSrc).toContain('traceRows.map');
    const commandPage = read('apps/web/app/command/page.tsx');
    expect(commandPage).toContain('traceRows={trace.rows}');
    const dict = read(DICT);
    expect(dict).toContain("realTraceTitle: 'REAL-TRACE · 真實行為'");
    expect(dict).toContain("realTraceTitle: 'REAL-TRACE · Real behaviour'");
  });

  it('the module is a build-time read, never a fetch', () => {
    const src = read(TRACE_MODULE);
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('process.env');
    expect(src).toContain('readFileSync');
  });
});
