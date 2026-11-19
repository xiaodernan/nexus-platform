'use client';

import { useState } from 'react';

/**
 * D1468 — the in-product orientation CTA. No auto-call: a click spends ONE model call,
 * the graph fences every byte, and a refusal renders nothing. The atlas dossier stays as-is.
 */
export type StoryRecapCopy = {
  cta: string;
  pending: string;
  proven: string;
  watchLabel: string;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ready'; recap: string; watch: string }
  | { kind: 'gone' };

export function StoryRecap({ locale, copy }: { locale: string; copy: StoryRecapCopy }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const ask = async () => {
    setPhase({ kind: 'pending' });
    try {
      const res = await fetch('/api/nexus/ai/story-recap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      const data: unknown = res.ok ? await res.json() : null;
      const recap = (data as { recap?: unknown } | null)?.recap;
      const degraded = (data as { degraded?: unknown } | null)?.degraded;
      if (data && degraded !== true && typeof recap === 'string' && recap.trim()) {
        const watch = (data as { watch?: unknown }).watch;
        setPhase({ kind: 'ready', recap: recap.trim(), watch: typeof watch === 'string' ? watch.trim() : '' });
        return;
      }
      setPhase({ kind: 'gone' });
    } catch {
      setPhase({ kind: 'gone' });
    }
  };

  if (phase.kind === 'gone') return null;

  return (
    <div className="not-prose my-6 flex flex-col items-start gap-3 rounded-2xl border border-line bg-surface p-5">
      <button
        type="button"
        onClick={ask}
        disabled={phase.kind === 'pending'}
        className="inline-flex items-center justify-center rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {phase.kind === 'pending' ? copy.pending : copy.cta}
      </button>
      {phase.kind === 'ready' ? (
        <div className="flex max-w-prose flex-col gap-2 rounded-xl border border-accent-line bg-canvas p-4">
          <p className="text-sm leading-relaxed text-ink-strong">{phase.recap}</p>
          {phase.watch ? (
            <p className="text-xs leading-relaxed text-ink-muted">
              <span className="font-semibold text-ink-strong">{copy.watchLabel} </span>
              {phase.watch}
            </p>
          ) : null}
          <p className="text-2xs leading-relaxed text-ink-faint">{copy.proven}</p>
        </div>
      ) : null}
    </div>
  );
}
