'use client';

/**
 * `/admin/analytics` — the §九 behavior-analytics view (D370).
 *
 * The gate is the password the owner published; entering it once stores it in
 * sessionStorage so the refresh keeps the view. The data comes from the AI service's
 * behavior read (`/ai/v1/admin/behavior`) through the BFF — real rows from the §58
 * events table, never fabricated. The copy is locale-switched from this file's own map:
 * dict.ts is a hot file both streams append to, and the analytics copy lives here so
 * the two streams do not collide on one block (the i18n contract — one language per
 * locale, no mixing — is unchanged).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

type Locale = 'zh-HK' | 'en';

interface Copy {
  title: string;
  intro: string;
  passwordLabel: string;
  passwordHint: string;
  unlock: string;
  wrong: string;
  totalEvents: string;
  dailyTitle: string;
  dailyHint: string;
  projectionTitle: string;
  projectionHint: string;
  sessionsTitle: string;
  sessionColumn: string;
  eventsColumn: string;
  topEventsTitle: string;
  recommendationsTitle: string;
  recommendationsHint: string;
  windowLabel: (hours: number) => string;
  needPassword: string;
}

const COPY: Record<Locale, Copy> = {
  'zh-HK': {
    title: '行為分析台',
    intro: '逐用戶事件流、統計與趨勢預測 — 數據來自 §58 events 表的真實行，不造假。',
    passwordLabel: '管理員密碼',
    passwordHint: '輸入管理員密碼以解鎖行為分析（教學：此頁觀察全部用戶的真實行為流）。',
    unlock: '解鎖',
    wrong: '密碼不對，再試一次。',
    totalEvents: '事件總數',
    dailyTitle: '每日事件',
    dailyHint: '教學：柱越高代表當日行為越多；對照 projection 看趨勢方向。',
    projectionTitle: '未來七日趨勢（線性投影）',
    projectionHint: '教學：虛線是按觀測窗口的線性外推 — 是參考，不是保證。',
    sessionsTitle: '活躍工作階段',
    sessionColumn: '工作階段',
    eventsColumn: '事件數',
    topEventsTitle: '事件類型分佈',
    recommendationsTitle: '下一步優化建議',
    recommendationsHint: '教學：由數據推導的下一動作 — 按建議落地即改善漏斗。',
    windowLabel: (hours) => `觀測窗口：過去 ${hours} 小時`,
    needPassword: '需要管理員密碼',
  },
  en: {
    title: 'Behavior analytics',
    intro: 'Per-user event streams, stats and a trend projection - real rows from the §58 events table, never fabricated.',
    passwordLabel: 'Admin password',
    passwordHint: 'Enter the admin password to unlock behavior analytics (how-to: this page watches every user\'s real event stream).',
    unlock: 'Unlock',
    wrong: 'Wrong password, try again.',
    totalEvents: 'Total events',
    dailyTitle: 'Events per day',
    dailyHint: 'How-to: taller bars mean more activity that day; read projection for the trend direction.',
    projectionTitle: 'Next 7 days (linear projection)',
    projectionHint: 'How-to: the dotted values are a least-squares extrapolation of the observed window - a reference, not a promise.',
    sessionsTitle: 'Active sessions',
    sessionColumn: 'Session',
    eventsColumn: 'Events',
    topEventsTitle: 'Event type distribution',
    recommendationsTitle: 'Next optimization moves',
    recommendationsHint: 'How-to: data-derived next actions - landing these improves the funnel.',
    windowLabel: (hours) => `Window: last ${hours} hours`,
    needPassword: 'Admin password required',
  },
};

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

function readLocale(): Locale {
  const jar = document.cookie.split(/;\s*/).find((c) => c.startsWith('nexus_locale='));
  const value = jar?.split('=')[1] ?? '';
  return value === 'en' ? 'en' : 'zh-HK';
}

export default function AdminAnalyticsPage() {
  const [locale, setLocale] = useState<Locale>('zh-HK');
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [data, setData] = useState<Behavior | null>(null);
  const [loading, setLoading] = useState(false);
  const copy = COPY[locale];

  useEffect(() => {
    setLocale(readLocale());
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
      <main className="mx-auto w-full max-w-2xl px-4 py-16">
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
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-12">
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
    </main>
  );
}
