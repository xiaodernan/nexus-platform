import type { Metadata } from 'next';

import { currentLocale } from '@/lib/i18n/server';
import { getDict } from '@/lib/i18n';
import { simulateJourneys, explainSnapshot } from '@/lib/user-journeys';
import { Container, Icon } from '@nexus/ui';
import Link from 'next/link';

/**
 * `/insights` — the operator's daily ghost scan. Everything on the page is rebuilt from the
 * HK date by a deterministic simulator (`src/lib/user-journeys.ts`): 22 synthetic readers,
 * an hour ramp, six profiles, a recommendation. No account, no cookie, no pixel — the same
 * store sees nothing, the operator sees the shape of a Tuesday. Bilingual in the same breath:
 * copy rides the dict, rhythms ride the simulator, both light per request.
 */

export async function generateMetadata(): Promise<Metadata> {
  const locale = await currentLocale();
  const dict = getDict(locale);
  return {
    title: dict.insights.title,
    description: dict.insights.intro,
    alternates: { canonical: '/insights' },
    robots: { index: false, follow: false },
  };
}

export default async function InsightsPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const t = dict.insights;
  const hkDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const snap = simulateJourneys(hkDate, locale);
  const band: Record<string, string> = { low: t.funnelLow, mid: t.funnelMid, high: t.funnelHigh };

  return (
    <div className="flex flex-col">
      <section className="relative overflow-hidden border-b border-line bg-surface">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(64rem 38rem at 88% -18%, rgb(var(--nexus-accent-rgb) / 0.14), transparent 65%), ' +
              'radial-gradient(46rem 30rem at -12% 28%, rgb(var(--nexus-accent-rgb) / 0.09), transparent 60%)',
          }}
        />
        <Container size="shell" className="relative py-12 sm:py-16">
          <span className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.22em] text-accent">
            <Icon name="trending" size={12} />
            {t.eyebrow}
          </span>
          <h1 className="mt-3 max-w-[26ch] text-4xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-5xl">
            {t.title}
          </h1>
          <p className="mt-3 max-w-prose leading-relaxed text-ink-muted">{t.intro}</p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-2xs font-medium text-ink-muted">
              <Icon name="shield" size={12} className="text-accent" />
              {t.ritual}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-accent-line bg-accent-soft px-3 py-1.5 text-2xs font-medium text-ink-strong">
              <Icon name="eye" size={12} className="text-accent" />
              {t.ambientTitle}
            </span>
          </div>
        </Container>
      </section>

      <Container size="shell" className="py-8">
        <p className="max-w-prose text-2xs leading-relaxed text-ink-faint">{t.ambientBody}</p>

        <dl className="mt-5 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-line bg-surface p-5">
            <dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{t.total}</dt>
            <dd className="mt-1 font-mono text-4xl font-semibold leading-none text-ink-strong">{snap.total}</dd>
            <p className="mt-2 text-2xs text-ink-faint">{snap.date}</p>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-5 sm:col-span-2">
            <dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{t.funnel}</dt>
            <dd className="mt-2 flex flex-wrap gap-2">
              {snap.buckets.map((b) => (
                <span
                  key={b.profile}
                  className="inline-flex items-baseline gap-2 rounded-lg border border-line bg-canvas px-3 py-1.5 text-xs"
                >
                  <span className="font-semibold text-ink-strong">{b.profile}</span>
                  <span className="font-mono text-accent">{b.count}×</span>
                </span>
              ))}
            </dd>
          </div>
        </dl>

        <section aria-labelledby="insights-ramp" className="mt-8 rounded-2xl border border-line bg-surface p-5">
          <h2 id="insights-ramp" className="text-2xs font-semibold uppercase tracking-wide text-accent">
            {t.hourRamp}
          </h2>
          <div className="mt-4 grid grid-cols-12 gap-1" aria-hidden="true">
            {snap.hourRamp.map((v, i) => {
              const intensity = Math.min(100, Math.max(0, v));
              return (
                <div key={i} className="flex flex-col gap-1">
                  <div
                    className="rounded-sm bg-accent"
                    style={{ height: `${Math.max(4, intensity)}px`, opacity: 0.22 + (intensity / 100) * 0.78 }}
                  />
                  <span className="text-[9px] text-ink-faint">{i}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="insights-table" className="mt-8 overflow-hidden rounded-2xl border border-line bg-surface">
          <h2 id="insights-table" className="border-b border-line bg-canvas px-5 py-3 text-2xs font-semibold uppercase tracking-wide text-accent">
            {t.table}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-2xs uppercase tracking-wide text-ink-faint">
                <tr>
                  <th className="px-5 py-2">{t.colProfile}</th>
                  <th className="px-5 py-2">{t.colCount}</th>
                  <th className="px-5 py-2">{t.colDwell}</th>
                  <th className="px-5 py-2">{t.colDrop}</th>
                  <th className="px-5 py-2">{t.colBand}</th>
                </tr>
              </thead>
              <tbody>
                {snap.buckets.map((b) => (
                  <tr key={b.profile} className="border-t border-line">
                    <td className="px-5 py-2.5 font-medium text-ink-strong">{b.profile}</td>
                    <td className="px-5 py-2.5 font-mono text-2xs">{b.count}</td>
                    <td className="px-5 py-2.5 font-mono text-2xs">{t.fmtDwell(b.avgDwellSec)}</td>
                    <td className="px-5 py-2.5 font-mono text-2xs">{b.dropRate}%</td>
                    <td className="px-5 py-2.5 text-2xs">{band[b.headOfFunnel] ?? b.headOfFunnel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-8 rounded-2xl border border-accent-line bg-accent-soft p-5">
          <h2 className="text-2xs font-semibold uppercase tracking-wide text-accent">{t.nextTitle}</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-strong">{snap.recommendation}</p>
          <p className="mt-3 text-2xs leading-relaxed text-ink-muted">{explainSnapshot(snap, locale).body}</p>
        </section>

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-2xs text-ink-faint">
          <span>{t.disclaimer}</span>
          <Link href="/handbook" className="inline-flex items-center gap-1 text-accent hover:underline">
            <Icon name="arrowLeft" size={11} />
            /handbook
          </Link>
        </footer>
      </Container>
    </div>
  );
}
