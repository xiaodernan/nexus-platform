import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Icon, Badge } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * `/chronicle` — the framing codex of the HK series: one city, one day, 105 chapters.
 * Three acts pinned straight from the actual corpus (real chapter numbers, real
 * timestamps — the codex claims nothing the series does not carry). SSR, dict-carried,
 * canonical /chronicle, no island.
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.chronicle.title,
    description: dict.chronicle.intro,
    alternates: { canonical: '/chronicle' },
  };
}

export default async function ChroniclePage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.chronicle;

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-line bg-surface">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(52rem 30rem at 88% -12%, rgb(var(--nexus-accent-rgb) / 0.14), transparent 65%)' }} />
        <div aria-hidden="true" className="nexus-dot-grid pointer-events-none absolute inset-0" />
        <span aria-hidden="true" className="nexus-ghost-glyph pointer-events-none absolute -right-4 top-8 hidden select-none xl:block">{'\u9999\u6E2F'}</span>
        <Container size="shell" className="relative flex flex-col gap-7 py-14 sm:py-20">
          <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.eyebrow}</span>
          <h1 className="max-w-[28ch] text-4xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-5xl">{copy.title}</h1>
          <p className="max-w-prose text-base leading-relaxed text-ink-muted">{copy.intro}</p>
        </Container>
      </section>

      <Container size="shell" className="py-10 sm:py-12">
        {/* The three acts */}
        <section aria-labelledby="chronicle-acts" className="flex flex-col gap-6">
          <h2 id="chronicle-acts" className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.actTitle}</h2>
          {copy.acts.map((act, i) => (
            <article key={i} className="rounded-2xl border border-line bg-surface p-6">
              <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-accent">{act.kicker}</span>
                <Badge tone="accent" size="sm">{i + 1} / 3</Badge>
              </header>
              <h3 className="mt-4 text-balance text-2xl font-semibold tracking-tight text-ink-strong">{act.title}</h3>
              <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">{act.blurb}</p>
              <ol className="mt-4 grid gap-2 sm:grid-cols-2">
                {act.beats.map((beat, j) => (
                  <li key={j} className="flex items-start gap-2 rounded-xl border border-line bg-canvas px-4 py-3 text-sm leading-relaxed text-ink-strong">
                    <Icon name="navigation" size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                    <span>{beat}</span>
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </section>

        {/* Finale */}
        <section aria-labelledby="chronicle-finale" className="mt-12 rounded-2xl border border-accent-line bg-accent-soft p-6">
          <h2 id="chronicle-finale" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.finaleTitle}</h2>
          <div className="mt-3 flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
            {copy.finaleBody.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link href="/hong-kong" className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover">
              {copy.ctaStory} <Icon name="navigation" size={13} aria-hidden="true" />
            </Link>
            <Link href="/stamp" className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent">
              {copy.ctaStamp} <Icon name="check" size={13} aria-hidden="true" />
            </Link>
            <Link href="/handbook" className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent">
              {copy.ctaHandbook} <Icon name="arrowRight" size={13} aria-hidden="true" />
            </Link>
          </div>
        </section>
      </Container>
    </div>
  );
}
