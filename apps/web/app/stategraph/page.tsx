import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Icon, Badge } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { StateGraphIsland } from '@/components/stategraph-island';

/**
 * `/stategraph` — the orchestrator graph explained in the open: the ENGINE section of the
 * handbook names it, this page teaches it. Four sections: why a graph not a chain, a
 * click-through rehearsal of one full turn, the enable switch, the honest limits.
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.stategraph.title,
    description: dict.stategraph.intro,
    alternates: { canonical: '/stategraph' },
  };
}

export default async function StateGraphPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.stategraph;

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-line bg-surface">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(52rem 30rem at 88% -12%, rgb(var(--nexus-accent-rgb) / 0.12), transparent 65%)' }} />
        <div aria-hidden="true" className="nexus-dot-grid pointer-events-none absolute inset-0" />
        <Container size="shell" className="relative flex flex-col gap-6 py-12 sm:py-14">
          <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.eyebrow}</span>
          <h1 className="max-w-[24ch] text-4xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-5xl">{copy.title}</h1>
          <p className="max-w-prose text-base leading-relaxed text-ink-muted">{copy.intro}</p>
        </Container>
      </section>

      <Container size="shell" className="py-10 sm:py-12">
        {/* I · Why a graph */}
        <section aria-labelledby="sg-runbook" className="flex flex-col gap-4">
          <h2 id="sg-runbook" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.runbookTitle}</h2>
          <div className="flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
            {copy.runbookBody.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <ul className="mt-1 grid gap-2 sm:grid-cols-2">
            {copy.runbookBullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-ink-strong">
                <Icon name="check" size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* II · The rehearsal */}
        <section aria-labelledby="sg-rehearsal" className="mt-12 grid items-start gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <h2 id="sg-rehearsal" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.rehearsalTitle}</h2>
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{copy.rehearsalNote}</p>
            <div className="rounded-xl border border-line bg-canvas px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-faint">
              make_plan → route → fanout → emit
            </div>
          </div>
          <StateGraphIsland copy={{
            startCta: copy.startCta,
            nextCta: copy.nextCta,
            resetCta: copy.resetCta,
            stepLabel: copy.stepLabel,
            steps: copy.steps,
            doneLine: copy.doneLine,
          }} />
        </section>

        {/* III · The switch */}
        <section aria-labelledby="sg-switch" className="mt-12 flex flex-col gap-4">
          <h2 id="sg-switch" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.switchTitle}</h2>
          <div className="flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
            {copy.switchBody.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <div className="rounded-xl border border-accent-line bg-accent-soft px-4 py-3 font-mono text-xs leading-relaxed text-accent">
            NEXUS_AI_ENGINE=graph
          </div>
          <ul className="mt-1 grid gap-2 sm:grid-cols-2">
            {copy.switchBullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-ink-strong">
                <Icon name="check" size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* IV · The truth */}
        <section aria-labelledby="sg-truth" className="mt-12 flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
          <h2 id="sg-truth" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.truthTitle}</h2>
          <div className="flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
            {copy.truthBody.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Badge tone="accent" size="sm">ENGINE</Badge>
            <span className="text-2xs leading-relaxed text-ink-faint">StateGraph 0.3.34 · fingerprint 18/18 · D1142 → D1241</span>
          </div>
        </section>

        <div className="mt-8 flex justify-end">
          <Link href="/handbook" className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent">
            {copy.ctaHandbook}
            <Icon name="arrowRight" size={14} aria-hidden="true" />
          </Link>
        </div>
      </Container>
    </div>
  );
}
