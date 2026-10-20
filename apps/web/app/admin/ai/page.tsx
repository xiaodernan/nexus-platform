import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@nexus/ui';

import { formatNumber } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { adminAiCostsRead, adminAiRunsRead, degradedRate, type CostGroupBy } from '@/lib/console-admin';
import { ConsoleSection, MetricCell, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConsoleTable } from '@/components/console/console-table';
import { AdminAsk } from '@/components/console/admin-ask';
import { AdminChrome, AdminDenied, adminSession } from '@/components/console/admin-shell';

/** `/admin/ai` — §70/§126: agent runs, the cost roll-up, and the read-only Analytics Agent ask-box. */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.adminConsole.aiTitle,
    description: dict.console.adminConsole.aiIntro,
    alternates: { canonical: '/admin/ai' },
    robots: { index: false, follow: false },
  };
}

function groupOf(raw: string | string[] | undefined): CostGroupBy {
  if (raw === 'model') return 'model';
  if (raw === 'day') return 'day';
  return 'agent';
}

export default async function AdminAiPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await props.searchParams;
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.console.adminConsole.ai;

  const access = await adminSession();
  if (!access.granted) return <AdminDenied access={access} locale={locale} />;

  const groupBy = groupOf(search.group);
  const [runs, costs] = await Promise.all([adminAiRunsRead({ limit: 50 }), adminAiCostsRead(groupBy)]);
  const rate = degradedRate(runs.data ?? []);

  const groups: CostGroupBy[] = ['agent', 'model', 'day'];

  return (
    <AdminChrome
      title={dict.console.adminConsole.aiTitle}
      intro={dict.console.adminConsole.aiIntro}
      section={dict.console.nav.ai}
      active="/admin/ai"
      locale={locale}
      access={access}
    >
      <ConsoleSection id="runs" title={copy.runsTitle} note={copy.runsIntro} icon="ai">
        {runs.status === 'failed' ? (
          <ReadFailure read={runs} locale={locale} title={dict.merchant.degradedTitle} />
        ) : (
          <>
            <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <MetricCell
                label={copy.degradedRate(rate === null ? '—' : `${(rate * 100).toFixed(1)}%`)}
                value={rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}
                note={<span className="text-2xs text-ink-faint">{copy.degradedDefinition}</span>}
                read={runs}
                locale={locale}
              />
              <MetricCell label={copy.runColumns.tokens} value={formatNumber((runs.data ?? []).length, dict.locale)} read={runs} locale={locale} />
            </div>
            <ConsoleTable
              caption={copy.runsTitle}
              head={[
                copy.runColumns.id,
                copy.runColumns.agent,
                copy.runColumns.model,
                copy.runColumns.status,
                copy.runColumns.degraded,
                copy.runColumns.latency,
                copy.runColumns.tokens,
                copy.runColumns.cost,
                copy.runColumns.started,
              ]}
              rows={(runs.data ?? []).map((run) => [
                <span key="i" className="font-mono text-2xs">{run.id}</span>,
                <span key="a" className="font-mono text-2xs text-ink-strong">{run.agent}</span>,
                <span key="m" className="font-mono text-2xs text-ink-muted">{run.model ?? '—'}</span>,
                <Badge key="s" tone={run.status === 'succeeded' ? 'positive' : run.status === 'failed' ? 'danger' : 'neutral'} size="sm">
                  {run.status ?? dict.console.common.notStated}
                </Badge>,
                run.degraded ? <Badge key="d" tone="warning" size="sm" icon="warning">{copy.runColumns.degraded}</Badge> : <span key="d">—</span>,
                <span key="l" className="font-mono text-2xs">{run.latency_ms === null ? '—' : `${run.latency_ms}ms`}</span>,
                <span key="t" className="font-mono text-2xs">{run.tokens ?? '—'}</span>,
                <span key="c" className="font-mono text-2xs">{run.cost_usd === null ? '—' : `$${run.cost_usd.toFixed(4)}`}</span>,
                <span key="st" className="font-mono text-2xs text-ink-faint">{run.started_at ?? '—'}</span>,
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.runsEmpty}</p>}
            />
            <SourceStamp read={runs} locale={locale} className="mt-2" />
          </>
        )}
      </ConsoleSection>

      <ConsoleSection id="costs" title={copy.costsTitle} note={copy.costsIntro} icon="wallet">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{dict.console.adminConsole.ai.groupBy.agent}</span>
          {groups.map((entry) => (
            <Link
              key={entry}
              href={`/admin/ai?group=${entry}`}
              className={
                entry === groupBy
                  ? 'rounded-full border border-accent bg-accent-soft px-2.5 py-1 text-xs text-accent'
                  : 'rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted hover:border-accent hover:text-accent'
              }
            >
              {copy.groupBy[entry]}
            </Link>
          ))}
        </div>

        {costs.status === 'failed' ? (
          <ReadFailure read={costs} locale={locale} title={dict.merchant.degradedTitle} />
        ) : (
          <>
            <ConsoleTable
              caption={copy.costsTitle}
              head={[copy.costColumns.key, copy.costColumns.runs, copy.costColumns.tokens, copy.costColumns.cost, copy.costColumns.share, copy.costColumns.latency]}
              rows={(costs.data ?? []).map((row) => [
                <span key="k" className="font-mono text-2xs text-ink-strong">{row.key}</span>,
                <span key="r" className="font-mono text-2xs">{row.runs ?? '—'}</span>,
                <span key="t" className="font-mono text-2xs">{row.tokens ?? '—'}</span>,
                <span key="c" className="font-mono text-2xs">{row.cost_usd === null ? copy.noSpend : `$${row.cost_usd.toFixed(4)}`}</span>,
                <span key="s" className="font-mono text-2xs">
                  {row.share === null ? '—' : `${(row.share * 100).toFixed(1)}%`}
                  <Badge tone="neutral" size="sm">{dict.console.common.derived}</Badge>
                </span>,
                <span key="l" className="font-mono text-2xs">{row.avg_latency_ms === null ? '—' : `${row.avg_latency_ms}ms`}</span>,
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.costsEmpty}</p>}
            />
            <SourceStamp read={costs} locale={locale} className="mt-2" />
          </>
        )}
      </ConsoleSection>

      <ConsoleSection id="ask" title={copy.askTitle} note={copy.askIntro} icon="search">
        <AdminAsk locale={locale} bffPath={undefined} />
      </ConsoleSection>
    </AdminChrome>
  );
}

export const dynamic = 'force-dynamic';
