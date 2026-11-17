'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';

export type ChapterAskLabels = {
  eyebrow: string;
  title: string;
  hint: string;
  placeholder: string;
  submit: string;
  pending: string;
  proven: string;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ready'; answer: string; citations: Array<{ id: string; title: string }> }
  | { kind: 'gone' };

/**
 * D1284 — the chapter's live companion, client-side and optional.
 *
 * The reader reads the chapter either way; this card only ADDS an ask box. On ANY failure —
 * mock provider, unreachable service, a reply that breaks the contract (wrong citation, URL
 * leak, a confident empty-citation answer) — the card removes itself and the chapter stands
 * exactly as rendered, with nothing else around it. The model is handed the chapter's own
 * excerpts and no other source of truth; when it cannot say, the card says nothing.
 *
 * The island never pre-fills, never polls, never retries, and stores nothing.
 */
export function ChapterAskLive({
  chapterSlug,
  locale,
  labels,
}: {
  chapterSlug: string;
  locale: string;
  labels: ChapterAskLabels;
}) {
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const ask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = question.trim();
    if (q.length < 3) return;
    setPhase({ kind: 'pending' });
    try {
      const res = await fetch('/api/nexus/ai/chapter-ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, chapterSlug, locale }),
      });
      const data: unknown = res.ok ? await res.json() : null;
      const answer = (data as { answer?: unknown } | null)?.answer;
      const citations = (data as { citations?: unknown } | null)?.citations;
      const degraded = (data as { degraded?: unknown } | null)?.degraded;
      if (
        data &&
        degraded !== true &&
        typeof answer === 'string' &&
        answer.trim().length > 0
      ) {
        setPhase({
          kind: 'ready',
          answer: answer.trim(),
          citations: Array.isArray(citations)
            ? citations
                .filter((c): c is { id: string; title: string } => typeof c?.id === 'string' && typeof c?.title === 'string')
                .slice(0, 3)
            : [],
        });
        return;
      }
      setPhase({ kind: 'gone' });
    } catch {
      setPhase({ kind: 'gone' });
    }
  };

  if (phase.kind === 'gone') return null;

  return (
    <section
      aria-label={labels.title}
      className="mt-2 flex max-w-3xl flex-col gap-3 rounded-2xl border border-line bg-surface p-5"
    >
      <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{labels.eyebrow}</p>
      <h2 className="text-base font-semibold tracking-tight text-ink-strong">{labels.title}</h2>
      <p className="max-w-prose text-xs leading-relaxed text-ink-muted">{labels.hint}</p>
      <form onSubmit={ask} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={labels.placeholder}
          aria-label={labels.title}
          maxLength={300}
          className="min-w-0 flex-1 rounded-xl border border-line bg-canvas px-4 py-2.5 text-sm text-ink-strong placeholder:text-ink-faint focus-visible:border-accent focus-visible:outline-none"
        />
        <button
          type="submit"
          disabled={phase.kind === 'pending'}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {phase.kind === 'pending' ? labels.pending : labels.submit}
        </button>
      </form>
      {phase.kind === 'ready' ? (
        <div className="flex flex-col gap-2 rounded-xl border border-accent-line bg-canvas p-4">
          <p className="text-2xs font-semibold uppercase tracking-wide text-accent">{labels.proven}</p>
          <p className="max-w-prose text-sm leading-relaxed text-ink-strong">{phase.answer}</p>
          {phase.citations.length > 0 ? (
            <ul className="grid gap-1 text-xs text-ink-muted">
              {phase.citations.map((c) => (
                <li key={c.id}>
                  <span className="font-mono text-accent">{c.id}</span>
                  {' · '}
                  {c.title}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
