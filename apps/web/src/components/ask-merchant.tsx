'use client';

/**
 * §142 — the consumer's side of a conversation with one merchant.
 *
 * A question opens (or continues) a thread through the BFF, which is the only code that holds a
 * service origin or the session. The answer arrives as the merchant-agent SSE stream; `degraded`
 * on the `done` frame is the agent saying it could not ground the answer — exactly the moment a
 * human should take over — so that state renders as a handoff notice, never as a silent answer.
 *
 * The demo branch is labelled as a demo. It reports `provider: demo`, writes nothing, and
 * deliberately does not render the handoff notice: a handoff that did not happen is a false claim.
 */

import Link from 'next/link';
import { useId, useState } from 'react';
import { Icon } from '@nexus/ui';
import { getDict } from '@/lib/i18n';
import { readSse } from '@/lib/sse';

interface Turn {
  question: string;
  answer: string;
  citations: string[];
  degraded: boolean;
  provider: string;
  runId: string;
  pending: boolean;
}

export function AskMerchant({
  merchantId,
  merchantSlug,
  locale,
}: {
  merchantId: string;
  merchantSlug: string;
  locale: string;
}) {
  const dict = getDict(locale);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [stage, setStage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [needSignIn, setNeedSignIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const inputId = useId();

  const reset = () => {
    setTurns([]);
    setConversationId(null);
    setStage(null);
    setError(null);
    setNeedSignIn(false);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const asked = question.trim();
    if (!asked || pending) return;
    setPending(true);
    setError(null);
    setNeedSignIn(false);
    setStage(null);
    setQuestion('');
    setTurns((previous) => [
      ...previous,
      { question: asked, answer: '', citations: [], degraded: false, provider: '', runId: '', pending: true },
    ]);
    const updateLast = (patch: Partial<Turn>) =>
      setTurns((previous) =>
        previous.map((turn, index) => (index === previous.length - 1 ? { ...turn, ...patch } : turn)),
      );
    const restore = () => {
      setTurns((previous) => previous.slice(0, -1));
      setQuestion(asked);
    };

    try {
      const response = await fetch('/api/nexus/conversations/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          merchant_id: merchantId,
          merchant_slug: merchantSlug,
          message: asked,
          conversation_id: conversationId,
          locale,
        }),
      });
      if (response.status === 401) {
        restore();
        setNeedSignIn(true);
        return;
      }
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        restore();
        setError(payload?.error?.message ?? payload?.error?.code ?? `HTTP ${response.status}`);
        return;
      }
      const id = response.headers.get('x-conversation-id');
      if (id) setConversationId(id);

      for await (const message of readSse(response.body)) {
        const data = (message.data ?? {}) as Record<string, unknown>;
        switch (message.event) {
          case 'status':
            setStage(typeof data.text === 'string' ? data.text : null);
            break;
          case 'summary':
            updateLast({
              answer: typeof data.text === 'string' ? data.text : '',
              citations: Array.isArray(data.citations)
                ? data.citations.filter((citation): citation is string => typeof citation === 'string')
                : [],
            });
            break;
          case 'done':
            updateLast({
              degraded: data.degraded === true,
              provider: typeof data.provider === 'string' ? data.provider : '',
              runId: typeof data.agent_run_id === 'string' ? data.agent_run_id : '',
              pending: false,
            });
            break;
          case 'error':
            setError(typeof data.message === 'string' ? data.message : dict.ask.errorBody);
            break;
          default:
            console.warn('[nexus] unknown merchant-agent event', message.event);
        }
      }
      updateLast({ pending: false });
    } catch {
      restore();
      setError(dict.ask.errorBody);
    } finally {
      setPending(false);
      setStage(null);
    }
  };

  return (
    <section aria-labelledby={`${inputId}-title`} className="mt-8 border-t border-line pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${inputId}-title`} className="inline-flex items-center gap-1.5 text-base font-semibold tracking-tight text-ink-strong sm:text-lg">
          <Icon name="ai" size={16} className="text-ai" />
          {dict.ask.title}
        </h2>
        {turns.length ? (
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-line px-2.5 py-1 text-2xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink-strong"
          >
            {dict.ask.clear}
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-ink-muted">{dict.ask.hint}</p>

      {turns.length ? (
        <ol aria-live="polite" className="mt-4 flex flex-col gap-4">
          {turns.map((turn) => (
            <li key={`${turn.question}-${turn.runId}`} className="rounded-lg border border-line bg-surface p-3.5">
              <p className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{dict.ask.you}</p>
              <p className="mt-0.5 text-sm font-medium text-ink-strong">{turn.question}</p>
              <div className="mt-2.5 rounded-md border border-accent-line bg-accent-soft/40 p-3">
                <p className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide text-ai">
                  <Icon name="ai" size={12} />
                  {dict.ask.agent}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-strong">
                  {turn.pending && !turn.answer ? (stage ?? dict.ask.submitting) : turn.answer}
                </p>
                {turn.citations.length ? (
                  <p className="mt-2 text-2xs text-ink-faint">{dict.ask.citations(turn.citations.length)}</p>
                ) : null}
                {turn.degraded && turn.provider !== 'demo' ? (
                  <div className="mt-2.5 rounded-md border border-warning/70 bg-warning-soft px-2.5 py-2">
                    <p className="text-xs font-medium text-ink-strong">{dict.ask.handoffTitle}</p>
                    <p className="mt-0.5 text-xs text-ink-muted">{dict.ask.handoffBody}</p>
                  </div>
                ) : null}
                {turn.provider === 'demo' ? (
                  <p className="mt-2 text-2xs text-ink-faint">{dict.ask.demoNote}</p>
                ) : null}
                {turn.runId && turn.provider !== 'demo' ? (
                  <p className="mt-1.5 text-2xs text-ink-faint">{dict.ask.runId(turn.runId)}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-ink-muted">{dict.ask.empty}</p>
      )}

      <form onSubmit={submit} className="mt-4 flex flex-col gap-2">
        <label htmlFor={inputId} className="sr-only">
          {dict.ask.placeholder}
        </label>
        <textarea
          id={inputId}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={2}
          maxLength={500}
          placeholder={dict.ask.placeholder}
          className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink-strong shadow-xs outline-none placeholder:text-ink-faint focus:border-accent"
        />
        <div className="flex items-center justify-between gap-3">
          <span aria-live="polite" className="min-h-4 text-2xs text-ink-faint">
            {pending ? (stage ?? dict.ask.submitting) : ''}
          </span>
          <button
            type="submit"
            disabled={pending || !question.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? dict.ask.submitting : dict.ask.submit}
          </button>
        </div>
      </form>

      {needSignIn ? (
        <div role="alert" className="mt-3 rounded-lg border border-accent-line bg-accent-soft/50 px-3.5 py-3">
          <p className="text-sm font-semibold text-ink-strong">{dict.ask.signInTitle}</p>
          <p className="mt-0.5 text-xs text-ink-muted">{dict.ask.signInBody}</p>
          <Link
            href="/signin"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            {dict.ask.signInCta}
          </Link>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-danger/60 bg-danger-soft px-3 py-2 text-xs text-ink-muted">
          <span className="font-medium text-ink-strong">{dict.ask.errorTitle}：</span>
          {error}
        </p>
      ) : null}
    </section>
  );
}
