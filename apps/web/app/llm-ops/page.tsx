import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Icon, Badge } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * `/llm-ops` — the operator's read of the model plane. Every number on the page is a
 * measurement that got committed — no copy floats above its evidence. Two jobs: (1) teach
 * the operator exactly how one request flows (`router.run` → adapter → response/cache
 * metadata), (2) keep the D1257 envelope flip permanently visible so no future caller can
 * ship past it by accident. Server-rendered, dict-carried, canonical /llm-ops, no island.
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.llmops.title,
    description: dict.llmops.intro,
    alternates: { canonical: '/llm-ops' },
  };
}

export default async function LlmOpsPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.llmops;

  const figure = (
    <figure className="rounded-2xl border border-accent-line bg-canvas p-5">
      <figcaption className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.figureTitle}</figcaption>
      <svg viewBox="0 0 560 150" role="img" aria-label={copy.figureTitle} className="mt-4 w-full text-2xs font-mono">
        {([
          { label: 'direct JSON · 81.5%', pct: 81.5, y: 34, tone: 'var(--nexus-ai-gradient)' },
          { label: 'SSE · 16.3%', pct: 16.3, y: 96, tone: 'var(--nexus-kpi-line, #9aa6b2)' },
        ] as const).map((row) => (
          <g key={row.label}>
            <text x="0" y={row.y - 6} fill="currentColor" fontSize="12">
              {row.label}
            </text>
            <rect x="0" y={row.y} width="500" height="18" rx="9" fill="var(--nexus-surface-muted, #e7eaef)" />
            <rect x="0" y={row.y} width={(row.pct / 100) * 500} height="18" rx="9" fill={row.tone}>
              <title>{row.label}</title>
            </rect>
          </g>
        ))}
      </svg>
      <p className="mt-3 font-mono text-[11px] leading-relaxed text-ink-faint">{copy.figureNote}</p>
    </figure>
  );

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
        {figure}

        {/* I · The wire */}
        <section aria-labelledby="lo-wire" className="mt-10 flex flex-col gap-4">
          <h2 id="lo-wire" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.envelopeTitle}</h2>
          <div className="flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
            {copy.envelopeBody.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <ul className="mt-1 grid gap-2 sm:grid-cols-2">
            {copy.envelopeBullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-ink-strong">
                <Icon name="check" size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* II · The prefix */}
        <section aria-labelledby="lo-prefix" className="mt-12 flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
          <h2 id="lo-prefix" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.prefixTitle}</h2>
          <div className="flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
            {copy.prefixBody.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <ul className="mt-1 grid gap-2 sm:grid-cols-2">
            {copy.prefixBullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-ink-strong">
                <Icon name="check" size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* III · The router */}
        <section aria-labelledby="lo-router" className="mt-12 flex flex-col gap-4">
          <h2 id="lo-router" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.routerTitle}</h2>
          <div className="flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
            {copy.routerBody.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <ul className="mt-1 grid gap-2 sm:grid-cols-2">
            {copy.routerBullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-ink-strong">
                <Icon name="check" size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* IV · The economics */}
        <section aria-labelledby="lo-cost" className="mt-12 flex flex-col gap-4 rounded-2xl border border-line bg-canvas p-6">
          <h2 id="lo-cost" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.costTitle}</h2>
          <div className="flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
            {copy.costBody.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <ul className="mt-1 grid gap-2 sm:grid-cols-2">
            {copy.costBullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-ink-strong">
                <Icon name="check" size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* V · The weekly probe */}
        <section aria-labelledby="lo-probe" className="mt-12 flex flex-col gap-4">
          <h2 id="lo-probe" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.probeTitle}</h2>
          <div className="flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
            {copy.probeBody.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <div className="rounded-xl border border-accent-line bg-accent-soft px-4 py-3 font-mono text-xs leading-relaxed text-accent">
            HTTPS_PROXY=http://127.0.0.1:7897 uv run python cache_probe.py
          </div>
          <ul className="mt-1 grid gap-2 sm:grid-cols-2">
            {copy.probeBullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-ink-strong">
                <Icon name="check" size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* VI · The truth */}
        <section aria-labelledby="lo-truth" className="mt-12 flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
          <h2 id="lo-truth" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.honestyTitle}</h2>
          <div className="flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
            {copy.honestyBody.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Badge tone="accent" size="sm">ENGINE</Badge>
            <span className="text-2xs leading-relaxed text-ink-faint">NEXUS_LLM_STREAM=true opts into SSE · defaults to direct JSON (D1257) · LangGraph 0.3.34 behind /stategraph (D1246)</span>
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
