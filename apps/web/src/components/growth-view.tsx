import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, Container, Icon } from '@nexus/ui';

import { formatDateTime } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import type { Collection, Guide } from '@/lib/types';
import { CardGrid } from './cards';
import { Breadcrumbs } from './directory-view';
import { LocaleDemoBadge } from './locale-badges';

/**
 * Guides and collections (§8 growth). The disclosure at the top of a guide is not decoration: a page
 * of AI-written prose is precisely what §30 tells us not to mass-produce, so the page states who
 * wrote it and whether a human has checked it, and the route withholds it from the index until
 * someone has.
 */

export function EditorialBadges({ reviewed, demo, locale }: { reviewed: boolean; demo: boolean; locale: string }) {
  const dict = getDict(locale);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={reviewed ? 'positive' : 'warning'} size="sm">
        {reviewed ? dict.growth.reviewed : dict.growth.unreviewed}
      </Badge>
      {demo ? <LocaleDemoBadge locale={locale} /> : null}
    </div>
  );
}

function Disclosure({ locale }: { locale: string }) {
  const dict = getDict(locale);
  return (
    <aside className="flex flex-col gap-1 rounded-lg border border-line bg-surface-muted px-4 py-3">
      <span className="flex items-center gap-2 text-xs font-semibold text-ink-strong">
        <Icon name="info" size={13} />
        {dict.growth.aiDisclosureTitle}
      </span>
      <p className="text-xs leading-relaxed text-ink-muted">{dict.growth.aiDisclosureText}</p>
    </aside>
  );
}

export function GuideView({ guide, locale }: { guide: Guide; locale: string }) {
  const dict = getDict(locale);
  const published = formatDate(guide.published_at, locale, dict.growth.publishedOn);
  const updated = formatDate(guide.updated_at, locale, dict.growth.updatedOn);

  return (
    <Container size="shell" className="flex flex-col gap-6 py-8 sm:py-12">
      <div className="flex flex-col gap-3">
        <Breadcrumbs
          items={[
            { label: dict.growth.guidesTitle, href: '/guides' },
            { label: guide.title, href: null },
          ]}
        />
        <h1 className="max-w-[32ch] text-3xl font-semibold leading-tight tracking-tight text-ink-strong sm:text-4xl">
          {guide.title}
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted sm:text-base">{guide.description}</p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-faint">
          <EditorialBadges reviewed={guide.reviewed_by_human} demo={guide.flags.demo === true} locale={locale} />
          {published ? <span>{published}</span> : null}
          {updated ? <span>{updated}</span> : null}
        </div>
      </div>

      {guide.generated_by === 'ai' ? <Disclosure locale={locale} /> : null}

      <article className="flex max-w-3xl flex-col gap-4">
        {/* `?? []` and not a cast: this line is where the live-mode crash landed, and a reader that cannot
            be handed an absent required field is a reader that cannot crash on one. The projection in
            lib/platform-guides.ts is what makes it present; this is the belt to that braces. */}
        {(guide.body_blocks ?? []).map((block, index) => {
          if (block.type === 'heading') {
            return (
              <h2 key={index} className="pt-2 text-xl font-semibold tracking-tight text-ink-strong sm:text-2xl">
                {block.text}
              </h2>
            );
          }
          if (block.type === 'paragraph') {
            return (
              <p key={index} className="text-sm leading-relaxed text-ink">
                {block.text}
              </p>
            );
          }
          if (block.type === 'list') {
            return (
              <ul key={index} className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ink">
                {block.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            );
          }
          return (
            <section key={index} aria-label={block.title} className="flex flex-col gap-3 pt-2">
              <h2 className="text-xl font-semibold tracking-tight text-ink-strong sm:text-2xl">{block.title}</h2>
              <CardGrid cards={block.items} locale={locale} />
            </section>
          );
        })}
      </article>
    </Container>
  );
}

export function CollectionView({ collection, locale }: { collection: Collection; locale: string }) {
  const dict = getDict(locale);
  const updated = formatDate(collection.updated_at, locale, dict.growth.updatedOn);
  return (
    <Container size="shell" className="flex flex-col gap-6 py-8 sm:py-12">
      <div className="flex flex-col gap-3">
        <Breadcrumbs
          items={[
            { label: dict.growth.collectionsTitle, href: '/collections' },
            { label: collection.title, href: null },
          ]}
        />
        <h1 className="max-w-[32ch] text-3xl font-semibold leading-tight tracking-tight text-ink-strong sm:text-4xl">
          {collection.title}
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted sm:text-base">{collection.description}</p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-faint">
          {/* A creator or model curating a list is an opinion, not a ranking algorithm — §66 says the
              page may not let the two look like the same thing. */}
          <Badge tone={collection.curated_by.type === 'editorial' ? 'accent' : 'neutral'} size="sm">
            {dict.growth.curatedBy(collection.curated_by.name)}
          </Badge>
          {collection.flags.demo === true ? <LocaleDemoBadge locale={locale} /> : null}
          {updated ? <span>{updated}</span> : null}
        </div>
      </div>
      <CardGrid cards={collection.items} locale={locale} />
    </Container>
  );
}

/** A timestamp becomes a sentence only if the payload really carried one. */
function formatDate(iso: string, locale: string, wrap: (value: string) => string): string | null {
  const value = formatDateTime(iso, locale);
  return value ? wrap(value) : null;
}

/** Shared index layout for `/guides` and `/collections`. */
export function GrowthIndex({
  title,
  intro,
  locale,
  notice,
  children,
}: {
  title: string;
  intro: string;
  locale: string;
  notice?: string | null;
  children: ReactNode;
}) {
  const dict = getDict(locale);
  return (
    <Container size="shell" className="flex flex-col gap-6 py-8 sm:py-12">
      <div className="flex flex-col gap-3">
        <Breadcrumbs items={[{ label: dict.brand.name, href: '/' }, { label: title, href: null }]} />
        <h1 className="text-3xl font-semibold leading-tight tracking-tight text-ink-strong sm:text-4xl">{title}</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted sm:text-base">{intro}</p>
      </div>
      {notice ? (
        <p className="flex items-center gap-2 rounded-md border border-warning/70 bg-warning-soft px-3 py-2 text-xs text-warning">
          <Icon name="warning" size={14} className="shrink-0" />
          {notice}
        </p>
      ) : null}
      {children}
    </Container>
  );
}

export function GrowthCardLink({ href, title, description, meta }: { href: string; title: string; description: string; meta: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 transition-colors hover:border-accent"
    >
      <span className="text-base font-semibold text-ink-strong">{title}</span>
      <span className="text-sm leading-relaxed text-ink-muted">{description}</span>
      <span className="text-2xs text-ink-faint">{meta}</span>
    </Link>
  );
}
