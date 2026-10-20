import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@nexus/ui';

import { formatMoney } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { nextReservationStates, reservationCounts, reservationDayKey, reservationsOnDay, reservationGuestLabel } from '@/lib/console-shared';
import { merchantReservationsRead } from '@/lib/console-merchant';
import { ConsoleSection, MetricCell, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConsoleTable } from '@/components/console/console-table';
import { ConfirmAction } from '@/components/console/confirm-action';
import { MerchantChrome, MerchantSignInStop, merchantSession } from '@/components/console/merchant-shell';

const RESERVATION_ENDPOINT = 'PATCH /api/v1/reservations/{id}';

/**
 * `/merchant/reservations` — the §6/§23 booking inbox. The transitions offered per row come from the
 * platform's own guarded state machine (`nextReservationStates`): a cancelled booking offers none,
 * because re-opening it would be a new booking, not a status change.
 */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.nav.reservations,
    description: dict.console.reservations.intro,
    alternates: { canonical: '/merchant/reservations' },
    robots: { index: false, follow: false },
  };
}

export default async function MerchantReservationsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await props.searchParams;
  const session = await merchantSession(search);
  const dict = getDict(session.locale);
  const copy = dict.console.reservations;
  if (session.blocked) return <MerchantSignInStop locale={session.locale} />;

  const scope = search.scope === 'all' ? 'all' : 'today';
  const read = await merchantReservationsRead(session.businessId);
  const rows = read.data ?? [];
  const today = reservationDayKey(new Date().toISOString());
  const visible = scope === 'today' ? reservationsOnDay(rows, today) : rows;
  const counts = reservationCounts(visible);
  const businessQuery = session.requested ? `&business=${encodeURIComponent(session.requested)}` : '';

  return (
    <MerchantChrome
      title={copy.title}
      intro={copy.intro}
      section={dict.console.nav.reservations}
      active="/merchant/reservations"
      locale={session.locale}
      demo={read.origin === 'mock'}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href={`/merchant/reservations?scope=today${businessQuery}`}
          className={scope === 'today' ? 'rounded-full border border-accent bg-accent-soft px-3 py-1.5 text-xs text-accent' : 'rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-muted hover:border-accent hover:text-accent'}
        >
          {copy.today}
        </Link>
        <Link
          href={`/merchant/reservations?scope=all${businessQuery}`}
          className={scope === 'all' ? 'rounded-full border border-accent bg-accent-soft px-3 py-1.5 text-xs text-accent' : 'rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-muted hover:border-accent hover:text-accent'}
        >
          {copy.all}
        </Link>
      </div>

      {read.status === 'failed' ? (
        <ReadFailure read={read} locale={session.locale} title={dict.merchant.degradedTitle} />
      ) : (
        <>
          <ConsoleSection id="counts" title={copy.title} icon="calendar">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <MetricCell label={copy.counts.total} value={String(counts.total)} read={read} locale={session.locale} />
              <MetricCell label={copy.counts.awaiting} value={String(counts.awaitingDecision)} read={read} locale={session.locale} />
              <MetricCell label={copy.counts.seated} value={String(counts.seated)} read={read} locale={session.locale} />
              <MetricCell label={copy.counts.cancelled} value={String(counts.cancelled)} read={read} locale={session.locale} />
              <MetricCell label={copy.counts.covers} value={String(counts.covers)} read={read} locale={session.locale} />
            </div>
            <SourceStamp read={read} locale={session.locale} className="mt-2" />
          </ConsoleSection>

          <ConsoleSection id="rows" title={scope === 'today' ? copy.today : copy.all} icon="list">
            <ConsoleTable
              caption={copy.title}
              head={[copy.columns.guest, copy.columns.party, copy.columns.slot, copy.columns.status, copy.columns.price, copy.columns.contact, copy.columns.notes, copy.columns.source, copy.advance]}
              rows={visible.map((row) => {
                const guest = reservationGuestLabel(row);
                const next = nextReservationStates(row.status);
                return [
                  <span key="g" className="font-medium">
                    {guest ?? dict.console.common.notStated}
                    {row.code ? <span className="ml-2 font-mono text-2xs text-ink-faint">{row.code}</span> : null}
                  </span>,
                  <span key="p" className="tabular-nums">{row.party_size ?? '—'}</span>,
                  <span key="s" className="font-mono text-2xs">{row.slot_start ?? dict.console.common.notStated}</span>,
                  <Badge key="st" tone={row.status === 'cancelled' || row.status === 'no_show' ? 'danger' : row.status === 'confirmed' || row.status === 'seated' ? 'positive' : 'warning'} size="sm">
                    {copy.statuses[row.status] ?? row.status}
                  </Badge>,
                  <span key="pr" className="font-mono text-2xs">
                    {row.price ? formatMoney(row.price, dict.locale) : dict.console.common.notStated}
                  </span>,
                  <span key="c" className="text-2xs text-ink-muted">
                    {row.contact?.phone ?? row.contact?.email ?? dict.console.common.notStated}
                  </span>,
                  <span key="n" className="max-w-[16rem] text-2xs text-ink-muted">{row.notes ?? '—'}</span>,
                  <span key="src" className="font-mono text-2xs text-ink-faint">{row.source ?? '—'}</span>,
                  next.length === 0 ? (
                    <span key="a" className="text-2xs text-ink-faint">—</span>
                  ) : (
                    <ConfirmAction
                      key="a"
                      locale={session.locale}
                      endpoint={RESERVATION_ENDPOINT}
                      choice={{
                        key: 'status',
                        label: copy.advance,
                        options: next.map((status) => ({ value: status, label: copy.advanceTo(copy.statuses[status] ?? status) })),
                      }}
                      label={copy.advance}
                      confirmTitle={copy.advance}
                      confirmText={copy.notWired}
                      variant="outline"
                      size="xs"
                    />
                  ),
                ];
              })}
              empty={<p className="text-sm text-ink-muted">{copy.empty}</p>}
            />
          </ConsoleSection>
        </>
      )}
    </MerchantChrome>
  );
}

export const dynamic = 'force-dynamic';
