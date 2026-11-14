import type { Metadata } from 'next';
import { Badge, Icon, EmptyState } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { adminSystemHealthRead, adminEventsRead } from '@/lib/console-admin';
import { ConsoleSection, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConsoleTable } from '@/components/console/console-table';
import { AdminChrome, AdminDenied, adminSession } from '@/components/console/admin-shell';

/** `/admin/system` — §9/§69. Each dependency's own word for its state is shown verbatim. */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.adminConsole.systemTitle,
    description: dict.console.adminConsole.systemIntro,
    alternates: { canonical: '/admin/system' },
    robots: { index: false, follow: false },
  };
}

export default async function AdminSystemPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.console.adminConsole.system;

  const access = await adminSession();
  if (!access.granted) return <AdminDenied access={access} locale={locale} />;

  const [read, eventsRead] = await Promise.all([adminSystemHealthRead(), adminEventsRead()]);
  const data = read.data;
  const events = eventsRead.data;

  return (
    <AdminChrome
      title={dict.console.adminConsole.systemTitle}
      intro={dict.console.adminConsole.systemIntro}
      section={dict.console.nav.system}
      active="/admin/system"
      locale={locale}
      access={access}
    >
      {read.status === 'failed' ? (
        <ReadFailure read={read} locale={locale} title={dict.merchant.degradedTitle} />
      ) : data ? (
        <>
          <ConsoleSection id="overall" title={dict.console.adminConsole.systemTitle} note={copy.sourceNote} icon="shield">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={data.overall === 'ok' ? 'positive' : data.overall === 'down' ? 'danger' : 'warning'} size="sm">
                {copy.overall[data.overall]}
              </Badge>
              {data.raw_status ? (
                <Badge tone="outline" size="sm">{copy.columns.rawState}: {data.raw_status}</Badge>
              ) : null}
              {data.version ? <Badge tone="neutral" size="sm">{copy.version}: {data.version}</Badge> : null}
              {data.schema_version ? <Badge tone="neutral" size="sm">{copy.schemaVersion}: {data.schema_version}</Badge> : null}
              {data.profiles.length > 0 ? (
                <Badge tone="outline" size="sm">{copy.profiles}: {data.profiles.join(', ')}</Badge>
              ) : null}
            </div>
            <p className="mt-2 flex max-w-3xl items-start gap-1.5 text-2xs text-ink-faint">
              <Icon name="info" size={12} className="mt-0.5 shrink-0" />
              {copy.notProbed}
            </p>
            <SourceStamp read={read} locale={locale} className="mt-2" />
          </ConsoleSection>

          <ConsoleSection id="dependencies" title={copy.dependenciesTitle} icon="layers">
            <ConsoleTable
              caption={copy.dependenciesTitle}
              head={[copy.columns.dependency, copy.columns.state, copy.columns.rawState, copy.columns.latency, copy.columns.detail]}
              rows={data.dependencies.map((dependency) => [
                <span key="n" className="font-mono text-2xs text-ink-strong">{dependency.name}</span>,
                <Badge key="s" tone={dependency.state === 'ok' ? 'positive' : dependency.state === 'down' ? 'danger' : dependency.state === 'degraded' ? 'warning' : 'neutral'} size="sm">
                  {copy.overall[dependency.state]}
                </Badge>,
                <span key="r" className="font-mono text-2xs">{dependency.raw_status ?? '—'}</span>,
                <span key="l" className="font-mono text-2xs">{dependency.latency_ms === null ? '—' : `${dependency.latency_ms}ms`}</span>,
                <span key="d" className="max-w-[18rem] text-2xs text-ink-muted">{dependency.detail ?? '—'}</span>,
              ])}
              empty={<EmptyState icon="grid" title={copy.dependenciesEmpty} className="py-6" />}
            />
          </ConsoleSection>

          <ConsoleSection id="events" title={copy.eventsTitle} icon="navigation">
            {eventsRead.status === 'failed' ? (
              <ReadFailure read={eventsRead} locale={locale} title={dict.merchant.degradedTitle} />
            ) : events ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {events.disabled ? (
                    <Badge tone="outline" size="sm">{copy.eventsDisabled}</Badge>
                  ) : events.degraded ? (
                    <Badge tone="warning" size="sm" icon="warning">{copy.eventsDegraded(events.degraded_reason ?? '')}</Badge>
                  ) : (
                    <Badge tone="positive" size="sm">{copy.eventsColumns.stream}</Badge>
                  )}
                  {events.xlen !== null ? <Badge tone="neutral" size="sm">{copy.eventsColumns.length}: {events.xlen}</Badge> : null}
                  {events.max_len !== null ? <Badge tone="outline" size="sm">{copy.eventsColumns.backlogNote}</Badge> : null}
                  {events.group ? (
                    <Badge tone={events.group.pending && events.group.pending > 0 ? 'warning' : 'positive'} size="sm">
                      {copy.eventsColumns.inFlight}: {events.group.pending ?? 0}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-2 text-2xs text-ink-faint">
                  {copy.eventsColumns.stream} · {events.source}
                  {events.group ? ` · ${events.group.name} (${events.group.consumers ?? 0} consumers, ${events.group.pending ?? 0} pending)` : null}
                </p>
                {Array.isArray(events.pending_detail) && events.pending_detail.length > 0 ? (
                  <ConsoleTable
                    caption={copy.pendingDetailTitle}
                    className="mt-3"
                    head={[copy.pendingColumns.id, copy.pendingColumns.consumer, copy.pendingColumns.idle, copy.pendingColumns.redeliveries]}
                    rows={(events.pending_detail ?? []).map((ev) => [
                      <span key="i" className="font-mono text-2xs">{ev.id}</span>,
                      <span key="c" className="font-mono text-2xs text-ink-strong">{ev.consumer ?? '—'}</span>,
                      <span key="m" className="font-mono text-2xs">{ev.idle_ms === null ? '—' : `${Math.round(ev.idle_ms / 1000)}s`}</span>,
                      <span key="r" className="font-mono text-2xs">{ev.redeliveries ?? '—'}</span>,
                    ])}
                    empty={<EmptyState icon="clock" title={copy.pendingDetailEmpty} className="py-6" />}
                  />
                ) : events.group && events.group.pending === 0 ? (
                  <p className="mt-3 text-sm text-ink-muted">{copy.pendingDetailEmpty}</p>
                ) : null}
                {Array.isArray(events.recent) && events.recent.length > 0 ? (
                  <ConsoleTable
                    caption={copy.eventsTitle}
                    className="mt-3"
                    head={['ID', 'template', 'type', 'tenant']}
                    rows={(events.recent ?? []).map((ev) => [
                      <span key="i" className="font-mono text-2xs">{ev.id}</span>,
                      <span key="t" className="font-mono text-2xs text-ink-strong">{ev.template ?? '—'}</span>,
                      <span key="y" className="font-mono text-2xs text-ink-muted">{ev.type ?? '—'}</span>,
                      <span key="n" className="font-mono text-2xs">{ev.tenant_id ?? '—'}</span>,
                    ])}
                    empty={<EmptyState icon="navigation" title={copy.eventsEmpty} className="py-6" />}
                  />
                ) : (
                  <p className="mt-3 text-sm text-ink-muted">{copy.eventsEmpty}</p>
                )}
                <SourceStamp read={eventsRead} locale={locale} className="mt-2" />
              </>
            ) : null}
          </ConsoleSection>
        </>
      ) : null}
    </AdminChrome>
  );
}

export const dynamic = 'force-dynamic';
