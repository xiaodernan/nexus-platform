'use client';

import { useState } from 'react';
import type { MouseEvent } from 'react';

export type AhWanLabels = {
  eyebrow: string;
  title: string;
  hint: string;
  placeholder: string;
  send: string;
  pending: string;
  proven: string;
};

type Turn = { role: 'user' | 'assistant'; content: string };
type Phase =
  | { kind: 'idle'; turns: Turn[] }
  | { kind: 'sending'; turns: Turn[] }
  | { kind: 'ready'; turns: Turn[] }
  | { kind: 'gone' };

/**
 * D1317 — Ah Wan's dialogue: one night-shift voice inside the arc.
 *
 * The daily page hosts exactly one living NPC, and nothing leaks out of it: her world, her voice,
 * her rules. Client-side history (capped, capped again here); each POST replies as Ah Wan in the
 * player's language. §105 posture: an unreachable model, a URL-leak, a wrong-language draft —
 * the island removes itself (or falls to a calm no-answer); the page stands exactly as rendered.
 *
 * The island never stores anything, never polls, never retries, and never speaks for itself.
 */
export function AhWanDialogue({
  locale,
  labels,
}: {
  locale: string;
  labels: AhWanLabels;
}) {
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle', turns: [] });

  const send = async (event?: MouseEvent<HTMLButtonElement>) => {
    event?.preventDefault();
    const line = message.trim();
    if (line.length < 1 || phase.kind === 'sending') return;
    const turns = (phase.kind === 'idle' || phase.kind === 'ready') ? phase.turns : [];
    const withTurn: Turn[] = [...turns, { role: 'user' as const, content: line }].slice(-12);
    setPhase({ kind: 'sending', turns: withTurn });
    setMessage('');
    try {
      const res = await fetch('/api/nexus/ai/npc-ah-wan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale, message: line, history: turns.slice(-12) }),
      });
      const data: unknown = res.ok ? await res.json() : null;
      const answer = (data as { answer?: unknown } | null)?.answer;
      const degraded = (data as { degraded?: unknown } | null)?.degraded;
      // An answer counts only when Ah Wan actually spoke (or the verified in-character fallback);
      // an empty answer in mock mode removes the island silently.
      if (
        data &&
        degraded !== true &&
        typeof answer === 'string' &&
        answer.trim().length > 0
      ) {
        setPhase({
          kind: 'ready',
          turns: [...withTurn, { role: 'assistant' as const, content: answer.trim() }].slice(-12),
        });
        return;
      }
      setPhase({ kind: 'gone' });
    } catch {
      setPhase({ kind: 'gone' });
    }
  };

  if (phase.kind === 'gone') return null;

  const turns = (phase.kind === 'idle' || phase.kind === 'sending' || phase.kind === 'ready') ? phase.turns : [];

  return (
    <section
      aria-label={labels.title}
      className="flex max-w-3xl flex-col gap-3 rounded-2xl border border-line bg-surface p-5"
    >
      <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{labels.eyebrow}</p>
      <h2 className="text-base font-semibold tracking-tight text-ink-strong">{labels.title}</h2>
      <p className="max-w-prose text-xs leading-relaxed text-ink-muted">{labels.hint}</p>

      {turns.length > 0 ? (
        <ol className="flex max-h-72 flex-col gap-2 overflow-y-auto rounded-xl border border-line bg-canvas p-3">
          {turns.map((turn, index) => (
            <li
              key={index}
              className={turn.role === 'user'
                ? 'self-end rounded-xl rounded-br-none border border-accent-line bg-accent-soft px-3 py-2 text-sm text-ink-strong'
                : 'self-start rounded-xl rounded-bl-none border border-line bg-surface px-3 py-2 text-sm text-ink-strong'}
            >
              {turn.content}
            </li>
          ))}
        </ol>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <input
          type="text"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={labels.placeholder}
          aria-label={labels.title}
          maxLength={220}
          className="min-w-0 flex-1 rounded-xl border border-line bg-canvas px-4 py-2.5 text-sm text-ink-strong placeholder:text-ink-faint focus-visible:border-accent focus-visible:outline-none"
        />
        <button
          type="submit"
          disabled={phase.kind === 'sending'}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {phase.kind === 'sending' ? labels.pending : labels.send}
        </button>
      </form>

      {phase.kind === 'ready' ? (
        <p className="text-2xs text-ink-faint">{labels.proven}</p>
      ) : null}
    </section>
  );
}
