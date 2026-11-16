/**
 * The committed evidence file — docs/evidence/user-journey-2026-11-16.md — parsed back into rows.
 *
 * Why a regex over the markdown rather than a JSON sidecar: the markdown is the document the
 * reader reads (it lands in the repo, in the readme, nowhere else). If somebody regenerates
 * it with `node scripts/user_journey_probe.mjs`, this export follows without maintaining two
 * trees. The whole file stays under 30 KB; parse at build time; no network; no env.
 *
 * NOTE: this module is server-only. Do NOT import from a client component; the row set is
 * handed to the client console by the server page (/command) as a plain prop.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, '..', '..', '..', '..', 'docs', 'evidence', 'user-journey-2026-11-16.md');

export interface RealTraceRow {
  readonly idx: number;
  readonly name: string;
  readonly duration_ms: number;
  readonly outcome: 'completed' | 'skipped' | 'crashed';
  readonly end_url: string;
  readonly scrollY: number;
}

export interface RealTraceSummary {
  readonly rows: ReadonlyArray<RealTraceRow>;
  readonly totals: {
    readonly journeys: number;
    /** Count of journeys marked completed in the ledger — 12 by construction today. */
    readonly completed: number;
    readonly crashed: number;
    readonly skipped: number;
    /** Sum of measured journey durations; observations, not SLAs. */
    readonly totalMs: number;
  };
}

const ROW_PATTERN = /^### (\d+)\. (.+?)\n- duration: (\d+) ms · outcome: \*\*(completed|skipped|crashed)\*\* · end_url: `([^`]*)`/gm;
const SCROLL_PATTERN = /- final scrollY: (\d+)/;

let cache: RealTraceSummary | null = null;

export function realTrace(): RealTraceSummary {
  if (cache) return cache;
  const rows: Array<RealTraceRow> = [];
  try {
    const text = readFileSync(EVIDENCE, 'utf8');
    for (const match of text.matchAll(ROW_PATTERN)) {
      const name = (match[2] ?? '').trim();
      const slice = text.slice(match.index ?? 0, (match.index ?? 0) + 1200);
      const scrollMatch = SCROLL_PATTERN.exec(slice);
      rows.push({
        idx: Number(match[1] ?? rows.length + 1),
        name,
        duration_ms: Number(match[3] ?? 0),
        outcome: (match[4] ?? 'completed') as RealTraceRow['outcome'],
        end_url: match[5] ?? '',
        scrollY: scrollMatch ? Number(scrollMatch[1]) : 0,
      });
    }
  } catch {
    // The evidence file not being checked out yet (fresh clone on a bare plane) must not
    // break the page: an empty set simply renders nothing.
  }
  cache = {
    rows,
    totals: {
      journeys: rows.length,
      completed: rows.filter((r) => r.outcome === 'completed').length,
      crashed: rows.filter((r) => r.outcome === 'crashed').length,
      skipped: rows.filter((r) => r.outcome === 'skipped').length,
      totalMs: rows.reduce((acc, r) => acc + r.duration_ms, 0),
    },
  };
  return cache;
}
