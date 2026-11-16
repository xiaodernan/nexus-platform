import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Icon, Badge } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * `/afterward` — the after-midnight codex of the closed arc: the tail the clock does not
 * carry. Five flashes between 00:00 and 06:40, every anchor cited to a real chapter.
 * SSR, dict-carried both locales, canonical /afterward, no island.
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.afterward.title,
    description: dict.afterward.intro,
    alternates: { canonical: '/afterward' },
  };
}

export default async function AfterwardPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.afterward;

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-line bg-surface">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(52rem 30rem at 88% -12%, rgb(var(--nexus-accent-rgb) / 0.12), transparent 65%)' }} />
        <div aria-hidden="true" className="nexus-dot-grid pointer-events-none absolute inset-0" />
        <span aria-hidden="true" className="nexus-ghost-glyph pointer-events-none absolute -right-4 top-8 hidden select-none xl:block">{'\u591C'}</span>
        <Container size="shell" className="relative flex flex-col gap-6 py-12 sm:py-14">
          <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.eyebrow}</span>
          <h1 className="max-w-[24ch] text-4xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-5xl">{copy.title}</h1>
          <p className="max-w-prose text-base leading-relaxed text-ink-muted">{copy.intro}</p>
        </Container>
      </section>

      <Container size="shell" className="py-10 sm:py-12">
        {/* Flashes */}
        <section aria-labelledby="afterward-flashes" className="flex flex-col gap-5">
          <h2 id="afterward-flashes" className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.actTitle}</h2>
          {copy.flashes.map((flash, i) => (
            <article key={i} className="rounded-2xl border border-line bg-surface p-6">
              <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-3">
                <time className="font-mono text-lg tabular-nums text-ink-strong">{flash.at}</time>
                <Badge tone="accent" size="sm">{flash.kicker}</Badge>
              </header>
              <p className="mt-4 max-w-prose text-base leading-relaxed text-ink-strong">{flash.body}</p>
            </article>
          ))}
        </section>

        {/* Finale */}
        <section aria-labelledby="afterward-finale" className="mt-10 rounded-2xl border border-accent-line bg-accent-soft p-6">
          <h2 id="afterward-finale" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.finaleTitle}</h2>
          <div className="mt-3 flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
            {copy.finaleBody.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link href="/chronicle" className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover">
              {copy.ctaChronicle} <Icon name="arrowRight" size={13} aria-hidden="true" />
            </Link>
            <Link href="/hong-kong" className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent">
              {copy.ctaStory} <Icon name="arrowRight" size={13} aria-hidden="true" />
            </Link>
          </div>
        </section>
      </Container>
    </div>
  );
}
