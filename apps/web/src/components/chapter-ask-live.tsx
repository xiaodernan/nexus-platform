'use client';

import { useEffect, useState } from 'react';
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

export type ChapterAskTurn = {
  question: string;
  answer: string;
  citations: Array<{ id: string; title: string }>;
};

const HISTORY_LIMIT = 8; // the BFF and the AI contract both cap at 8 pairs

/**
 * D1284 — the chapter's live companion, client-side and optional (multi-turn since D1454).
 *
 * The reader reads the chapter either way; this card only ADDS an ask box. Ask follow-ups to
 * your heart's content — every fence-validated answer joins the session's growing context and
 * the provider's prefix cache serves the conversation turn over turn. On ANY failure —
 * mock provider, unreachable service, a reply that breaks the contract (wrong citation, URL
 * leak, a confident empty-citation answer) — the card removes itself and the chapter stands
 * exactly as rendered, with nothing else around it. The model is handed the chapter's own
 * excerpts and no other source of truth; when it cannot say, the card says nothing.
 *
 * The island never pre-fills, never polls, never retries, and stores nothing (memory only,
 * gone when the page reloads).
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
  const [turns, setTurns] = useState<ChapterAskTurn[]>([]);
  const [phase, setPhase] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'gone' }
  >({ kind: 'idle' });

  // the conversation belongs to the chapter + locale the reader picked
  useEffect(() => {
    setTurns([]);
    setPhase({ kind: 'idle' });
    setQuestion('');
  }, [chapterSlug, locale]);

  const ask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = question.trim();
    if (q.length < 3 || phase.kind === 'pending') return;
    setPhase({ kind: 'pending' });
    const history = turns.slice(-HISTORY_LIMIT).map((t) => ({ question: t.question, answer: t.answer }));
    try {
      const res = await fetch('/api/nexus/ai/chapter-ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, chapterSlug, locale, history }),
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
        setTurns((prev) => [
          ...prev,
          {
            question: q,
            answer: answer.trim(),
            citations: Array.isArray(citations)
              ? citations
                  .filter((c): c is { id: string; title: string } => typeof c?.id === 'string' && typeof c?.title === 'string')
                  .slice(0, 3)
              : [],
          },
        ]);
        setQuestion('');
        setPhase({ kind: 'idle' });
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

      {turns.length > 0 ? (
        <div className="flex flex-col gap-2">
          {turns.map((t, i) => (
            <div
              key={`${i}-${t.question}`}
              className="flex flex-col gap-1.5 rounded-xl border border-line bg-canvas px-4 py-3"
            >
              <p className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
                <span className="font-mono text-accent">Q</span>
                {' · '}
                {t.question}
              </p>
              <p className="text-sm leading-relaxed text-ink-strong">{t.answer}</p>
              {t.citations.length > 0 ? (
                <ul className="grid gap-0.5 text-2xs text-ink-muted">
                  {t.citations.map((c) => (
                    <li key={c.id}>
                      <span className="font-mono text-accent">{c.id}</span>
                      {' · '}
                      {c.title}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
          <p className="text-2xs uppercase tracking-wide text-ink-faint">{labels.proven}</p>
        </div>
      ) : null}

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
    </section>
  );
}
