import type { Metadata } from 'next';
import { Badge, Icon } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { adminSystemHealthRead } from '@/lib/console-admin';
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

  const read = await adminSystemHealthRead();
  const data = read.data;

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
              empty={<p className="text-sm text-ink-muted">{copy.dependenciesEmpty}</p>}
            />
          </ConsoleSection>
        </>
      ) : null}
    </AdminChrome>
  );
}

export const dynamic = 'force-dynamic';
