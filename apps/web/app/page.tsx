import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Icon, Reveal } from '@nexus/ui';

import { homeRails, type RailKey } from '@/lib/data';
import type { EntityCard } from '@/lib/types';
import { resolveGeo } from '@/lib/geo';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { examplePrompts } from '@/lib/prompts';
import { CardRail } from '@/components/cards';
import { SearchBox } from '@/components/search-box';

/**
 * Home (§6): the search box is the product. Everything below it is a rail of EntityCards built from
 * the same facts the AI service uses, and the rails that could not be fetched are simply absent —
 * the page never substitutes fixtures into a live response to look complete.
 */

export async function generateMetadata(): Promise<Metadata> {
  const locale = await currentLocale();
  const dict = getDict(locale);
  return {
    title: `${dict.brand.name} — ${dict.brand.tagline}`,
    description: dict.home.subtitle,
    alternates: { canonical: '/' },
  };
}

export default async function HomePage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const locale = await currentLocale();
  const dict = getDict(locale);
  const geo = resolveGeo({ lat: params.lat, lng: params.lng, district: params.district });
  const rails = await homeRails({ geo, locale, signedIn: false });
  const prompts = examplePrompts(locale);

  const railSections = (
    [
      { key: 'popular_near_you' as RailKey, cards: rails.data.popular_near_you as EntityCard[] },
      { key: 'for_you' as RailKey, cards: rails.data.for_you as EntityCard[] },
      { key: 'trending' as RailKey, cards: rails.data.trending as EntityCard[] },
      { key: 'recommended' as RailKey, cards: rails.data.recommended as EntityCard[] },
      { key: 'recently_viewed' as RailKey, cards: rails.data.recently_viewed as EntityCard[] },
    ] as Array<{ key: RailKey; cards: EntityCard[] }>
  ).filter((section) => section.cards.length > 0);

  return (
    <>
      <section className="relative overflow-hidden border-b border-line bg-surface">
        {/* One visual moment, no new copy: two low-alpha gradient glows anchored to the page corners
            give the hero a sense of depth in both light and dark themes without touching tokens. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(64rem 38rem at 88% -18%, rgb(var(--nexus-accent-rgb) / 0.14), transparent 65%), ' +
              'radial-gradient(46rem 30rem at -12% 28%, rgb(var(--nexus-accent-rgb) / 0.09), transparent 60%)',
          }}
        />
        <Container size="shell" className="relative flex flex-col gap-7 py-14 sm:py-20">
          <Reveal>
            <span className="flex items-center gap-2">
              <span aria-hidden="true"
                    className="h-2 w-2 rounded-full shadow-xs ring-1 ring-inset ring-black/10"
                    style={{ background: 'var(--nexus-ai-gradient)' }} />
              <span className="text-2xs font-semibold uppercase tracking-wide text-accent">{dict.home.eyebrow}</span>
            </span>
            <h1 className="mt-2 max-w-[22ch] text-4xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-5xl lg:text-6xl">
              {dict.home.title}
            </h1>
            <p className="mt-3 max-w-prose text-base leading-relaxed text-ink-muted sm:text-lg">{dict.home.subtitle}</p>
          </Reveal>

          <Reveal delay={0.06} className="w-full max-w-3xl">
            <SearchBox locale={locale} size="lg" />
          </Reveal>

          <div className="flex flex-col gap-2">
            <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{dict.home.examplesLabel}</span>
            <ul className="flex flex-wrap gap-2">
              {prompts.map((prompt) => (
                <li key={prompt.key}>
                  <Link
                    href={`/search?q=${encodeURIComponent(prompt.query)}`}
                    className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-line bg-surface px-3.5 py-2 text-sm text-ink-muted shadow-xs transition-colors hover:border-accent hover:text-accent"
                  >
                    <Icon name="quote" size={12} className="shrink-0 text-ink-faint" />
                    {prompt.query}
                  </Link>
                </li>
              ))}
            </ul>
            <span className="mt-3 text-2xs font-medium uppercase tracking-wide text-ink-faint">{dict.home.districtsLabel}</span>
            <ul className="flex flex-wrap gap-2">
              {dict.home.districtChips.map((chip) => (
                <li key={chip.district}>
                  <Link
                    href={`/search?q=${encodeURIComponent(chip.q)}`}
                    aria-label={chip.label}
                    className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-accent-line bg-accent-soft px-3.5 py-2 text-sm text-accent shadow-xs transition-colors hover:border-accent hover:bg-accent-soft hover:brightness-[0.98] hover:shadow-sm"
                  >
                    <Icon name="map" size={12} className="shrink-0 text-accent" />
                    {chip.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Container>
      </section>

      <Container size="shell" className="flex flex-col">
        {rails.degraded ? (
          <p className="mt-6 flex items-center gap-2 rounded-md border border-warning/70 bg-warning-soft px-3 py-2 text-xs text-warning">
            <Icon name="warning" size={14} className="shrink-0" />
            {rails.degradedReason}
          </p>
        ) : null}

        {railSections.map((section) => (
          <CardRail
            key={section.key}
            id={section.key}
            title={dict.home.rails[section.key].title}
            description={dict.home.rails[section.key].description}
            cards={section.cards}
            locale={locale}
            action={
              section.key === 'popular_near_you' ? (
                <Link href="/search" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
                  {dict.nav.search}
                  <Icon name="navigation" size={13} />
                </Link>
              ) : undefined
            }
          />
        ))}
      </Container>

      <section className="border-t border-line bg-surface">
        <Container size="shell" className="py-12">
          <h2 className="text-xl font-semibold tracking-tight text-ink-strong sm:text-2xl">{dict.home.stepsTitle}</h2>
          <ol className="mt-6 grid gap-5 sm:grid-cols-3">
            {dict.home.steps.map((step, index) => (
              <li key={step.title} className="flex flex-col gap-1.5 rounded-lg border border-line bg-canvas p-4">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-2xs font-semibold text-accent">
                  {index + 1}
                </span>
                <span className="text-sm font-semibold text-ink-strong">{step.title}</span>
                <span className="text-xs leading-relaxed text-ink-muted">{step.text}</span>
              </li>
            ))}
          </ol>
        </Container>
      </section>
    </>
  );
}
