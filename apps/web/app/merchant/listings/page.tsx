import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { Badge, Icon } from '@nexus/ui';

import { merchantBySlug } from '@/lib/data';
import { DATA_MODE, IS_MOCK, SESSION_COOKIE } from '@/lib/env';
import { formatMoney } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import type { ListingDraft } from '@/lib/console-shared';
import { merchantOverviewRead } from '@/lib/console-merchant';
import { DEMO_CONSOLE_BUSINESS } from '@/lib/console-fixtures';
import { LocaleDemoBadge } from '@/components/locale-badges';
import { ConsoleNav, merchantNavItems } from '@/components/console/console-nav';
import {
  ConsoleContainer,
  ConsoleDemoBanner,
  ConsolePageHeader,
  ConsoleSection,
  ReadFailure,
  SignInRequired,
  SourceStamp,
} from '@/components/console/console-parts';
import { ListingEditor } from '@/components/console/listing-editor';

/**
 * `/merchant/listings` — §47: the merchant edits their own data. The draft is loaded from the
 * documented reads (`overview` for identity + the public merchant read for the profile), the form
 * itself is a client component so unsaved edits never touch a network, and the submit path is
 * explicit about what is wired: nothing, in demo mode.
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.listingsTitle,
    description: dict.console.listingsIntro,
    alternates: { canonical: '/merchant/listings' },
    robots: { index: false, follow: false },
  };
}

export default async function MerchantListingsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const search = await props.searchParams;
  const requested = typeof search.business === 'string' && search.business ? search.business : null;

  const jar = await cookies();
  const signedIn = Boolean(jar.get(SESSION_COOKIE)?.value);

  const header = (
    <ConsolePageHeader
      title={dict.console.listingsTitle}
      intro={dict.console.listingsIntro}
      locale={locale}
      badges={
        <>
          {IS_MOCK ? <LocaleDemoBadge locale={locale} /> : null}
          <Badge tone="outline" size="sm">{dict.console.sections.listings}</Badge>
        </>
      }
    />
  );

  if (!IS_MOCK && !signedIn) {
    return (
      <ConsoleContainer>
        {header}
        <ConsoleNav items={merchantNavItems(locale)} active="/merchant/listings" label={dict.console.nav.merchant} />
        <SignInRequired locale={locale} />
        <p className="text-xs text-ink-muted">{dict.console.listings.signInBlockNote}</p>
      </ConsoleContainer>
    );
  }

  const businessId = requested ?? DEMO_CONSOLE_BUSINESS;
  const overview = await merchantOverviewRead(businessId);
  const page = overview.data ? await merchantBySlug(overview.data.slug) : null;
  const detail = page?.data?.detail ?? null;
  const offerings = page?.data?.offerings.items ?? [];

  const initial: ListingDraft | null = detail
    ? {
        name: detail.name,
        tagline: detail.tagline ?? '',
        description: detail.description ?? '',
        phone: detail.locations[0]?.phone ?? '',
        price_amount: detail.avg_price?.amount ?? '',
      }
    : null;

  return (
    <ConsoleContainer>
      {header}
      <ConsoleNav items={merchantNavItems(locale)} active="/merchant/listings" label={dict.console.nav.merchant} />
      {IS_MOCK ? <ConsoleDemoBanner locale={locale} /> : null}
      <p className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Icon name="arrowLeft" size={13} />
        <Link href="/merchant" className="text-accent hover:underline">
          {dict.console.merchantTitle}
        </Link>
      </p>

      {overview.status === 'failed' ? <ReadFailure read={overview} locale={locale} title={dict.merchant.degradedTitle} /> : null}
      {page && page.degraded ? (
        <p className="flex items-center gap-2 rounded-md border border-warning/70 bg-warning-soft px-3 py-2 text-xs text-warning">
          <Icon name="warning" size={14} className="shrink-0" />
          {dict.merchant.degradedTitle}: {page.degradedReason}
        </p>
      ) : null}

      {detail && initial ? (
        <>
          <ConsoleSection
            id="edit"
            title={dict.console.listings.editTitle}
            note={detail.flags.demo ? dict.console.demoIdentityNote(detail.name) : undefined}
            icon="settings"
          >
            <ListingEditor locale={locale} mode={DATA_MODE} businessId={overview.data?.merchant_id ?? businessId} initial={initial} />
            <SourceStamp read={overview} locale={locale} className="mt-4" />
          </ConsoleSection>

          <ConsoleSection id="rows" title={dict.console.listings.rowsTitle} icon="list">
            {offerings.length === 0 ? (
              <p className="text-sm text-ink-muted">{dict.console.listings.empty}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
                {offerings.map((offering) => (
                  <li key={offering.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                    <Link href={`/o/${offering.slug}`} className="min-w-0 flex-1 truncate text-sm font-medium text-ink-strong hover:text-accent">
                      {offering.title}
                    </Link>
                    <span className="text-xs text-ink-muted">{offering.kind}</span>
                    {offering.price ? (
                      <span className="font-mono text-xs text-ink-strong">
                        {formatMoney({ amount: offering.price.amount, currency: offering.price.currency }, dict.locale) ?? offering.price.amount}
                      </span>
                    ) : null}
                    {offering.flags.demo ? <LocaleDemoBadge locale={locale} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </ConsoleSection>
        </>
      ) : overview.status === 'ok' ? (
        <p className="text-sm text-ink-muted">{dict.states.empty}</p>
      ) : null}
    </ConsoleContainer>
  );
}

export const dynamic = 'force-dynamic';
