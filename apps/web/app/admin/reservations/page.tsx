import type { Metadata } from 'next';
import { Badge } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { adminReservationsRead } from '@/lib/console-admin';
import { ConsoleSection, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConsoleTable } from '@/components/console/console-table';
import { AdminChrome, AdminDenied, adminSession } from '@/components/console/admin-shell';

/** `/admin/reservations` — §9. Documented but unserved in this build, so live mode degrades visibly. */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.adminConsole.reservationsTitle,
    description: dict.console.adminConsole.reservationsIntro,
    alternates: { canonical: '/admin/reservations' },
    robots: { index: false, follow: false },
  };
}

export default async function AdminReservationsPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.console.adminConsole.reservations;

  const access = await adminSession();
  if (!access.granted) return <AdminDenied access={access} locale={locale} />;

  const read = await adminReservationsRead();
  const rows = read.data ?? [];

  return (
    <AdminChrome
      title={dict.console.adminConsole.reservationsTitle}
      intro={dict.console.adminConsole.reservationsIntro}
      section={dict.console.nav.adminReservations}
      active="/admin/reservations"
      locale={locale}
      access={access}
    >
      <ConsoleSection id="reservations" title={dict.console.adminConsole.reservationsTitle} icon="calendar">
        {read.status === 'failed' ? (
          <div className="flex flex-col gap-2">
            <p className="max-w-3xl text-xs leading-relaxed text-ink-muted">{copy.listUnavailable}</p>
            <ReadFailure read={read} locale={locale} title={dict.merchant.degradedTitle} />
          </div>
        ) : (
          <>
            <ConsoleTable
              caption={dict.console.adminConsole.reservationsTitle}
              head={[copy.columns.id, copy.columns.status, copy.columns.party, copy.columns.startsAt, copy.columns.merchant, copy.columns.created]}
              rows={rows.map((row) => [
                <span key="i" className="font-mono text-2xs">{row.id}</span>,
                <Badge key="s" tone={row.status === 'cancelled' ? 'danger' : row.status === 'confirmed' ? 'positive' : 'neutral'} size="sm">
                  {row.status ?? dict.console.common.notStated}
                </Badge>,
                <span key="p" className="font-mono text-2xs">{row.party_size ?? '—'}</span>,
                <span key="st" className="font-mono text-2xs">{row.starts_at ?? '—'}</span>,
                <span key="m" className="text-2xs text-ink-muted">{row.merchant_name ?? '—'}</span>,
                <span key="c" className="font-mono text-2xs text-ink-faint">{row.created_at ?? '—'}</span>,
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
