'use client';

/**
 * The streamed search experience (§116) — one component, three states that must stay honest:
 *
 *  1. **Streaming**: the canonical `intent|status|results|summary|error|done` events from
 *     `/api/nexus/ai/stream` drive a `LoadingStage` list. Stages the model never reached stay
 *     `pending`; nothing is fished out of the client's own imagination.
 *  2. **Degraded (§105)**: an `error` event or a failed request falls back to the deterministic
 *     `POST /api/nexus/ai/search`, and the notice says so. A degraded page still shows results —
 *     it just never pretends they were explained by the model.
 *  3. **Empty**: `EmptyState` with the reason. Padding a miss with unrelated merchants would be
 *     the exact §155 failure the relevance floor exists to prevent, so the list stays empty.
 *
 * Grouping is re-derived from `card.group` here rather than imported from `lib/mock`: pulling the
 * mock module into a client component would ship 700 lines of fixtures to browsers running in
 * live mode.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, ErrorState, Icon, LoadingStage, type Stage } from '@nexus/ui';
import type { CompareResult, EntityCard as EntityCardModel, GeoPoint } from '@nexus/ui/trust/types';
import { getDict, normalizeLocale } from '@/lib/i18n';
import { examplePrompts } from '@/lib/prompts';
import { readSse } from '@/lib/sse';
import type { Intent, SearchResponse, StreamStage } from '@/lib/types';
import { CardGrid, CompareTray } from './cards';
import { SearchBox } from './search-box';

const STAGES: StreamStage[] = ['understanding', 'searching', 'comparing', 'summarizing', 'done'];
const GROUP_ORDER = ['best_match', 'best_value', 'closest', 'most_popular'] as const;

interface StreamState {
  query: string;
  stages: Stage[];
  cards: EntityCardModel[];
  intent: Intent | null;
  summary: { text: string; citations: string[] } | null;
  done: { latency_ms: number; provider: string; runId: string } | null;
  degraded: boolean;
  failure: { code: string; message: string; requestId: string | null } | null;
  pending: boolean;
}

function emptyState(query: string, locale: string): StreamState {
  const dict = getDict(locale);
  return {
    query,
    stages: STAGES.map((stage, index) => ({
      key: stage,
      label: dict.search.stages[stage],
      state: index === 0 ? 'active' : 'pending',
    })),
    cards: [],
    intent: null,
    summary: null,
    done: null,
    degraded: false,
    failure: null,
    pending: true,
  };
}

/** Mark `current` active and everything before it done — the shape of a real pipeline. */
function advance(stages: Stage[], current: string, failed = false): Stage[] {
  const index = stages.findIndex((stage) => stage.key === current);
  if (index === -1) return stages;
  return stages.map((stage, position) => {
    if (position < index) return { ...stage, state: stage.state === 'failed' ? 'failed' : 'done' };
    if (position === index) return { ...stage, state: failed ? 'failed' : 'active' };
    return stage;
  });
}

function finish(stages: Stage[], failed: boolean): Stage[] {
  return stages.map((stage) =>
    stage.state === 'failed' ? stage : { ...stage, state: failed && stage.key !== 'done' ? 'pending' : 'done' },
  );
}

function grouped(cards: EntityCardModel[]): Array<{ key: (typeof GROUP_ORDER)[number]; cards: EntityCardModel[] }> {
  return GROUP_ORDER.map((key) => ({ key, cards: cards.filter((card) => (card.group ?? 'most_popular') === key) })).filter(
    (group) => group.cards.length > 0,
  );
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json };
}

export function SearchResults({
  initialQuery,
  geo,
  locale,
  forceStreamError = false,
}: {
  initialQuery: string;
  geo: GeoPoint | null;
  locale: string;
  /** §105 review hook: ask the stream to fail so the fallback is visible without stopping :8000. */
  forceStreamError?: boolean;
}) {
  const dict = getDict(locale);
  const [query, setQuery] = useState(initialQuery);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<StreamState>(() => emptyState(initialQuery, locale));
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<CompareResult | null>(null);
  const intentRef = useRef<Intent | null>(null);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    if (!query) {
      setState({ ...emptyState('', locale), pending: false });
      return;
    }
    const controller = new AbortController();
    setState(emptyState(query, locale));

    const deterministicFallback = async (reason: string, requestId: string | null) => {
      const result = await postJson(
        '/api/nexus/ai/search',
        { query, geo, locale },
      );
      if (result.ok && result.json) {
        const payload = result.json as SearchResponse;
        setState((previous) => ({
          ...previous,
          cards: payload.items ?? [],
          degraded: true,
          failure: { code: reason, message: dict.search.errorText, requestId },
          pending: false,
          stages: finish(previous.stages, false),
        }));
        return;
      }
      setState((previous) => ({
        ...previous,
        pending: false,
        degraded: true,
        failure: {
          code: reason,
          message: (result.json as { error?: { message?: string } } | null)?.error?.message ?? dict.search.errorText,
          requestId,
        },
        stages: previous.stages.map((stage) => (stage.state === 'active' ? { ...stage, state: 'failed' } : stage)),
      }));
    };

    const run = async () => {
      let response: Response;
      try {
        response = await fetch('/api/nexus/ai/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            query,
            previous_intent: intentRef.current,
            geo,
            locale,
            // Ignored by the BFF unless mock mode is on.
            force_error: forceStreamError,
          }),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) return;
        await deterministicFallback('stream_unreachable', null);
        return;
      }
      if (!response.ok || !response.body) {
        const code =
          ((await response.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? 'stream_failed';
        await deterministicFallback(code, response.headers.get('x-request-id'));
        return;
      }

      let streamFailed = false;
      for await (const message of readSse(response.body)) {
        if (controller.signal.aborted) return;
        switch (message.event) {
          case 'status': {
            const data = message.data as { stage?: string };
            if (data?.stage) setState((previous) => ({ ...previous, stages: advance(previous.stages, data.stage as string) }));
            break;
          }
          case 'intent': {
            intentRef.current = message.data as Intent;
            setState((previous) => ({ ...previous, intent: message.data as Intent }));
            break;
          }
          case 'results': {
            const data = message.data as { items?: EntityCardModel[] };
            setState((previous) => ({ ...previous, cards: data.items ?? [], stages: advance(previous.stages, 'summarizing') }));
            break;
          }
          case 'summary': {
            const data = message.data as { text?: string; citations?: string[] };
            setState((previous) => ({
              ...previous,
              summary: { text: data.text ?? '', citations: data.citations ?? [] },
              stages: advance(previous.stages, 'done'),
            }));
            break;
          }
          case 'done': {
            const data = message.data as { agent_run_id?: string; latency_ms?: number; provider?: string; degraded?: boolean };
            setState((previous) => ({
              ...previous,
              done: {
                latency_ms: data.latency_ms ?? 0,
                provider: data.provider ?? 'unknown',
                runId: data.agent_run_id ?? '',
              },
              degraded: data.degraded === true,
              pending: false,
              stages: finish(previous.stages, streamFailed),
            }));
            break;
          }
          case 'error': {
            const data = message.data as { code?: string; message?: string };
            streamFailed = true;
            intentRef.current = null;
            await deterministicFallback(data.code ?? 'ai_unavailable', null);
            return;
          }
          default:
            // An event the contract does not define is a bug to surface, not one to swallow.
            console.warn('[nexus] unknown stream event', message.event);
        }
      }
      // Upstream closed without `done`: the response was truncated, so say so instead of hanging.
      setState((previous) =>
        previous.pending
          ? {
              ...previous,
              pending: false,
              degraded: true,
              failure: { code: 'stream_incomplete', message: dict.search.errorText, requestId: null },
              stages: previous.stages.map((stage) => (stage.state === 'active' ? { ...stage, state: 'failed' } : stage)),
            }
          : previous,
      );
    };

    void run();
    return () => controller.abort();
    // `attempt` is the retry counter; `query` is the only other input the stream needs.
  }, [query, attempt, geo, locale, dict, forceStreamError]);

  useEffect(() => {
    if (compareIds.length < 2) {
      setComparison(null);
      return;
    }
    const controller = new AbortController();
    void postJson('/api/nexus/ai/compare', { subject_ids: compareIds, geo })
      .then((result) => {
        if (!controller.signal.aborted && result.ok) setComparison(result.json as CompareResult);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [compareIds, geo]);

  const toggleCompare = useCallback((card: EntityCardModel) => {
    setCompareIds((previous) =>
      previous.includes(card.id) ? previous.filter((id) => id !== card.id) : [...previous, card.id].slice(-4),
    );
  }, []);

  const compareCards = useMemo(
    () => compareIds.map((id) => state.cards.find((card) => card.id === id)).filter((card): card is EntityCardModel => Boolean(card)),
    [compareIds, state.cards],
  );

  if (!query) {
    return (
      <div className="flex flex-col gap-5">
        <SearchBox locale={locale} onSubmitQuery={setQuery} size="lg" />
        <div className="flex flex-wrap gap-2">
          {examplePrompts(normalizeLocale(locale)).map((example) => (
            <button
              key={example.key}
              type="button"
              onClick={() => setQuery(example.query)}
              className="rounded-full border border-line bg-surface px-3.5 py-2 text-left text-sm text-ink-muted shadow-xs transition-colors hover:border-accent hover:text-accent"
            >
              {example.query}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const groups = grouped(state.cards);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <SearchBox locale={locale} initialQuery={query} size="md" onSubmitQuery={setQuery} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-ink-strong sm:text-2xl">{dict.search.title(query)}</h1>
          <Button variant="ghost" size="sm" onClick={() => setQuery('')} leadingIcon={<Icon name="search" size={14} />}>
            {dict.search.newSearch}
          </Button>
        </div>
      </div>

      {state.pending || state.degraded ? (
        <LoadingStage
          stages={state.stages}
          degraded={state.degraded}
          degradedLabel={dict.search.degraded}
          liveLabel={dict.search.stages.understanding}
        />
      ) : null}

      {state.summary ? (
        <section aria-live="polite" className="rounded-lg border border-accent-line bg-accent-soft/60 p-4 sm:p-5">
          <p className="text-[0.9375rem] leading-relaxed text-ink-strong">{state.summary.text}</p>
          <footer className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-muted">
            <span className="inline-flex items-center gap-1">
              <Icon name="ai" size={12} className="text-ai" />
              {dict.search.citations(state.summary.citations.length)}
            </span>
            {state.done ? <span>{dict.search.meta(state.done.latency_ms, state.done.provider)}</span> : null}
            {state.done?.runId ? <span className="font-mono">{dict.search.runId(state.done.runId)}</span> : null}
          </footer>
        </section>
      ) : null}

      {state.failure && !state.cards.length ? (
        <ErrorState
          title={dict.search.errorTitle}
          description={state.failure.message}
          requestId={state.failure.requestId}
          hint={state.failure.code}
          retryAction={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                intentRef.current = null;
                setAttempt((value) => value + 1);
              }}
              leadingIcon={<Icon name="refresh" size={14} />}
            >
              {dict.search.retry}
            </Button>
          }
        />
      ) : null}

      {!state.pending && !state.cards.length && !state.failure ? (
        <EmptyState
          icon="search"
          title={dict.search.emptyTitle}
          description={dict.search.emptyText}
          action={
            <>
              <span className="text-xs text-ink-faint">{dict.search.emptyHint}</span>
              <Button size="sm" variant="outline" onClick={() => setQuery('')}>
                {dict.search.newSearch}
              </Button>
            </>
          }
        />
      ) : null}

      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`group-${group.key}`}>
          <h2 id={`group-${group.key}`} className="text-base font-semibold text-ink-strong">
            {dict.search.groups[group.key].title}
          </h2>
          <p className="mb-3 mt-0.5 text-xs text-ink-muted">{dict.search.groups[group.key].description}</p>
          <CardGrid cards={group.cards} locale={locale} compare={{ selected: compareIds, onToggle: toggleCompare }} />
        </section>
      ))}

      {compareCards.length >= 2 ? (
        <CompareTray
          cards={compareCards}
          result={comparison}
          locale={locale}
          onClear={() => setCompareIds([])}
          onRemove={toggleCompare}
        />
      ) : null}

      {state.cards.length ? (
        <div className="rounded-lg border border-line bg-surface p-4 shadow-xs">
          <p className="mb-2 text-sm font-medium text-ink-strong">{dict.search.followUpLabel}</p>
          {/* §34: the two refinements the conversation contract names, one tap instead of a sentence.
              Each label doubles as the utterance, so the chip says exactly what it submits. */}
          <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={dict.search.followUpLabel}>
            <Button size="sm" variant="outline" onClick={() => setQuery(dict.search.refineCheaper)}>
              {dict.search.refineCheaper}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setQuery(dict.search.refineCloser)}>
              {dict.search.refineCloser}
            </Button>
          </div>
          <SearchBox
            locale={locale}
            size="md"
            label={dict.search.followUpLabel}
            placeholder={dict.search.followUpPlaceholder}
            onSubmitQuery={setQuery}
          />
        </div>
      ) : null}
    </div>
  );
}
