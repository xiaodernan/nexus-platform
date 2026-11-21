'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dict } from '@/lib/i18n';

export type AdminAnalyticsCopy = Dict['adminAnalytics'];



interface Behavior {
  window_hours: number;
  total_events: number;
  daily: Array<[string, number]>;
  projection_next_7_days: Array<{ day_index: number; projected: number }>;
  top_events: Array<{ name: string; n: number }>;
  sessions: Array<{ session_id: string; n: number; first_at: string; last_at: string }>;
  recommendations: string[];
}

const GATE_KEY = 'nexus.analytics.unlocked';


export function AdminAnalyticsClient({ copy }: { copy: AdminAnalyticsCopy }) {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [data, setData] = useState<Behavior | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setUnlocked(sessionStorage.getItem(GATE_KEY) === '1');
  }, []);

  const load = useCallback(async (hours: number) => {
    setLoading(true);
    setWrong(false);
    try {
      const res = await fetch(`/api/nexus/ai/admin/behavior?password=123&hours=${hours}`, {
        headers: { 'x-tenant': 'hong-kong' },
      });
      if (res.status === 403) {
        setWrong(true);
        return;
      }
      setData((await res.json()) as Behavior);
      sessionStorage.setItem(GATE_KEY, '1');
      setUnlocked(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const unlock = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (password === '123') {
        setPassword('');
        void load(720);
      } else {
        setWrong(true);
      }
    },
    [password, load],
  );

  const maxDaily = useMemo(() => Math.max(1, ...(data?.daily ?? []).map(([, n]) => n)), [data]);
  const maxProjection = useMemo(
    () => Math.max(1, ...(data?.projection_next_7_days ?? []).map((p) => p.projected)),
    [data],
  );

  if (!unlocked) {
    return (
      <section className="mx-auto w-full max-w-2xl px-4 py-16">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-strong">{copy.title}</h1>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-muted">{copy.intro}</p>
        <form onSubmit={unlock} className="mt-8 flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
          <label className="text-sm font-medium text-ink-strong" htmlFor="analytics-password">
            {copy.passwordLabel}
          </label>
          <input
            id="analytics-password"
            type="password"
            inputMode="numeric"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink-strong outline-none focus-visible:ring-2 focus-visible:ring-accent"
            autoComplete="off"
          />
          {wrong ? <p className="text-sm text-danger">{copy.wrong}</p> : null}
          <button
            type="submit"
            className="mt-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {copy.unlock}
          </button>
          <p className="text-xs leading-relaxed text-ink-faint">{copy.passwordHint}</p>
        </form>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight text-ink-strong">{copy.title}</h1>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-muted">{copy.intro}</p>
      <p className="mt-1 text-xs uppercase tracking-[0.18em] text-ink-faint">
        {copy.windowLabel(data?.window_hours ?? 720)}
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-line bg-surface p-4">
          <p className="text-2xs uppercase tracking-[0.18em] text-ink-faint">{copy.totalEvents}</p>
          <p className="mt-1 text-2xl font-semibold text-ink-strong">{data?.total_events ?? 0}</p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-4">
          <p className="text-2xs uppercase tracking-[0.18em] text-ink-faint">{copy.sessionsTitle}</p>
          <p className="mt-1 text-2xl font-semibold text-ink-strong">{data?.sessions.length ?? 0}</p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-4">
          <p className="text-2xs uppercase tracking-[0.18em] text-ink-faint">{copy.topEventsTitle}</p>
          <p className="mt-1 text-2xl font-semibold text-ink-strong">{data?.top_events.length ?? 0}</p>
        </div>
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-ink-strong">{copy.dailyTitle}</h2>
        <p className="mt-1 text-xs text-ink-muted">{copy.dailyHint}</p>
        <div className="mt-4 flex items-end gap-1.5" aria-hidden="true">
          {(data?.daily ?? []).map(([day, n]) => (
            <div key={day} className="flex min-w-[3rem] flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-t bg-accent/70"
                style={{ height: `${Math.round((n / maxDaily) * 120) + 4}px` }}
                title={`${day}: ${n}`}
              />
              <span className="text-2xs text-ink-faint">{day.slice(5)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-ink-strong">{copy.projectionTitle}</h2>
        <p className="mt-1 text-xs text-ink-muted">{copy.projectionHint}</p>
        <div className="mt-4 flex items-end gap-1.5" aria-hidden="true">
          {(data?.projection_next_7_days ?? []).map((p) => (
            <div key={p.day_index} className="flex min-w-[3rem] flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-t border border-dashed border-accent-line bg-accent-soft/50"
                style={{ height: `${Math.round((p.projected / maxProjection) * 120) + 4}px` }}
                title={`+${p.day_index - (data?.daily.length ?? 0)}d: ${p.projected}`}
              />
              <span className="text-2xs text-ink-faint">+{p.day_index - (data?.daily.length ?? 0)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-ink-strong">{copy.topEventsTitle}</h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {(data?.top_events ?? []).map((row) => (
            <li
              key={row.name}
              className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-muted"
            >
              <span className="font-medium text-ink-strong">{row.name}</span>
              <span>{row.n}</span>
            </li>
          ))}
        </ul>
      </section>

      {(data?.sessions.length ?? 0) > 0 ? (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-ink-strong">{copy.sessionsTitle}</h2>
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase tracking-[0.14em] text-ink-faint">
                <th className="p-2">{copy.sessionColumn}</th>
                <th className="p-2">{copy.eventsColumn}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.sessions ?? []).map((row) => (
                <tr key={row.session_id} className="border-b border-line/60">
                  <td className="max-w-[18rem] truncate p-2 font-mono text-xs text-ink-muted">
                    {row.session_id}
                  </td>
                  <td className="p-2 text-ink-strong">{row.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-ink-strong">{copy.recommendationsTitle}</h2>
        <p className="mt-1 text-xs text-ink-muted">{copy.recommendationsHint}</p>
        <ul className="mt-3 flex flex-col gap-2">
          {(data?.recommendations ?? []).map((rec) => (
            <li
              key={rec}
              className="rounded-md border border-accent-line bg-accent-soft/40 px-3 py-2 text-sm leading-relaxed text-ink-strong"
            >
              {rec}
            </li>
          ))}
        </ul>
      </section>

      <button
        type="button"
        onClick={() => void load(data?.window_hours ?? 720)}
        disabled={loading}
        className="mt-10 rounded-md border border-line px-4 py-2 text-sm font-medium text-ink-strong transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      >
        {loading ? '…' : copy.unlock}
      </button>
    </section>
  );
}
