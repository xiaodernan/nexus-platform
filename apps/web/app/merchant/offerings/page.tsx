import type { Metadata } from 'next';
import { Badge } from '@nexus/ui';

import { formatMoney } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { merchantOfferingsRead } from '@/lib/console-merchant';
import { ConsoleSection, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConsoleTable } from '@/components/console/console-table';
import { OfferingForm } from '@/components/console/offering-form';
import { MerchantChrome, MerchantSignInStop, merchantSession } from '@/components/console/merchant-shell';

/** `/merchant/offerings` — the §23 catalogue list plus the §5 create form. */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.nav.offerings,
    description: dict.console.offerings.intro,
    alternates: { canonical: '/merchant/offerings' },
    robots: { index: false, follow: false },
  };
}

export default async function MerchantOfferingsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await merchantSession(await props.searchParams);
  const dict = getDict(session.locale);
  const copy = dict.console.offerings;
  if (session.blocked) return <MerchantSignInStop locale={session.locale} />;

  const offerings = await merchantOfferingsRead(session.businessId);

  return (
    <MerchantChrome
      title={copy.title}
      intro={copy.intro}
      section={dict.console.nav.offerings}
      active="/merchant/offerings"
      locale={session.locale}
      demo={offerings.origin === 'mock'}
    >
      <ConsoleSection id="offerings" title={copy.title} note={copy.intro} icon="store">
        {offerings.status === 'failed' ? (
          <ReadFailure read={offerings} locale={session.locale} title={dict.merchant.degradedTitle} />
        ) : (
          <>
            <ConsoleTable
              caption={copy.title}
              head={[copy.columns.title, copy.columns.kind, copy.columns.price, copy.columns.status, copy.columns.updated]}
              rows={(offerings.data ?? []).map((row) => [
                <span key="t" className="flex items-center gap-2">
                  <span className="font-medium">{row.title}</span>
                  {row.slug ? <span className="font-mono text-2xs text-ink-faint">/o/{row.slug}</span> : null}
                </span>,
                <Badge key="k" tone="neutral" size="sm">
                  {copy.kinds[row.kind] ?? row.kind}
                </Badge>,
                <span key="p" className="font-mono text-2xs">
                  {row.price ? formatMoney(row.price, dict.locale) : dict.console.common.notStated}
                </span>,
                row.status ? (
                  <Badge key="s" tone={row.status === 'active' ? 'positive' : 'neutral'} size="sm">
                    {row.status}
                  </Badge>
                ) : (
                  <span key="s" className="text-ink-faint">{dict.console.common.notStated}</span>
                ),
                <span key="u" className="font-mono text-2xs text-ink-faint">
                  {row.updated_at ?? dict.console.common.notStated}
                </span>,
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.empty}</p>}
            />
            <SourceStamp read={offerings} locale={session.locale} className="mt-2" />
          </>
        )}
      </ConsoleSection>

      <ConsoleSection id="create" title={copy.createTitle} icon="plus">
        <OfferingForm locale={session.locale} bffPath={undefined} />
      </ConsoleSection>
    </MerchantChrome>
  );
}

export const dynamic = 'force-dynamic';
