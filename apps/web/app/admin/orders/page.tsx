import type { Metadata } from 'next';
import { Badge } from '@nexus/ui';

import { formatMoney } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { adminOrdersRead } from '@/lib/console-admin';
import { ConsoleSection, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConsoleTable } from '@/components/console/console-table';
import { AdminChrome, AdminDenied, adminSession } from '@/components/console/admin-shell';

/** `/admin/orders` — §9. Documented but unserved in this build, so live mode degrades visibly. */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.adminConsole.ordersTitle,
    description: dict.console.adminConsole.ordersIntro,
    alternates: { canonical: '/admin/orders' },
    robots: { index: false, follow: false },
  };
}

export default async function AdminOrdersPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.console.adminConsole.orders;

  const access = await adminSession();
  if (!access.granted) return <AdminDenied access={access} locale={locale} />;

  const read = await adminOrdersRead();
  const rows = read.data ?? [];

  return (
    <AdminChrome
      title={dict.console.adminConsole.ordersTitle}
      intro={dict.console.adminConsole.ordersIntro}
      section={dict.console.nav.orders}
      active="/admin/orders"
      locale={locale}
      access={access}
    >
      <ConsoleSection id="orders" title={dict.console.adminConsole.ordersTitle} icon="wallet">
        {read.status === 'failed' ? (
          <div className="flex flex-col gap-2">
            <p className="max-w-3xl text-xs leading-relaxed text-ink-muted">{copy.listUnavailable}</p>
            <ReadFailure read={read} locale={locale} title={dict.merchant.degradedTitle} />
          </div>
        ) : (
          <>
            <ConsoleTable
              caption={dict.console.adminConsole.ordersTitle}
              head={[copy.columns.id, copy.columns.status, copy.columns.total, copy.columns.items, copy.columns.merchant, copy.columns.created]}
              rows={rows.map((row) => [
                <span key="i" className="font-mono text-2xs">{row.id}</span>,
                <Badge key="s" tone={row.status === 'refunded' ? 'danger' : row.status === 'paid' ? 'positive' : 'neutral'} size="sm">
                  {row.status ?? dict.console.common.notStated}
                </Badge>,
                <span key="t" className="font-mono text-2xs">{row.total ? formatMoney(row.total, dict.locale) : dict.console.common.notStated}</span>,
                <span key="c" className="font-mono text-2xs">{row.item_count ?? '—'}</span>,
                <span key="m" className="text-2xs text-ink-muted">{row.merchant_name ?? '—'}</span>,
                <span key="cr" className="font-mono text-2xs text-ink-faint">{row.created_at ?? '—'}</span>,
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.empty}</p>}
            />
            <SourceStamp read={read} locale={locale} className="mt-2" />
          </>
        )}
      </ConsoleSection>
    </AdminChrome>
  );
}

export const dynamic = 'force-dynamic';
