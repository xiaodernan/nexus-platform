import type { Metadata } from 'next';
import { Badge, Icon } from '@nexus/ui';

import { formatMoney } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { importJobStages, importProposalCounts, proposalIsLowConfidence } from '@/lib/console-shared';
import { merchantImportJobRead } from '@/lib/console-merchant';
import { LocaleDemoBadge } from '@/components/locale-badges';
import { ConsoleSection, MetricCell, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConsoleTable } from '@/components/console/console-table';
import { ConfirmAction } from '@/components/console/confirm-action';
import { MerchantChrome, MerchantSignInStop, merchantSession } from '@/components/console/merchant-shell';

const PROPOSAL_ENDPOINT = 'POST /api/v1/merchant/imports/{job_id}/proposals/{id}/confirm';

/**
 * `/merchant/imports` — the §22 extraction pipeline. A proposal is never auto-accepted: each row
 * carries its own confirm action, and the ones below the confidence floor or without cited evidence
 * are flagged, because those are the rows a person actually has to look at.
 */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.nav.imports,
    description: dict.console.imports.intro,
    alternates: { canonical: '/merchant/imports' },
    robots: { index: false, follow: false },
  };
}

export default async function MerchantImportsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await props.searchParams;
  const session = await merchantSession(search);
  const dict = getDict(session.locale);
  const copy = dict.console.imports;
  if (session.blocked) return <MerchantSignInStop locale={session.locale} />;

  const jobId = typeof search.job === 'string' && search.job ? search.job : session.businessId;
  const read = await merchantImportJobRead(jobId);
  const job = read.data;
  const counts = job ? importProposalCounts(job.proposals) : null;
  const stages = job ? importJobStages(job.status) : [];

  return (
    <MerchantChrome
      title={copy.title}
      intro={copy.intro}
      section={dict.console.nav.imports}
      active="/merchant/imports"
      locale={session.locale}
      demo={read.origin === 'mock'}
    >
      <ConsoleSection id="job" title={copy.title} note={copy.intro} icon="download">
        {read.status === 'failed' ? (
          <ReadFailure read={read} locale={session.locale} title={dict.merchant.degradedTitle} />
        ) : job ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone={job.status === 'succeeded' || job.status === 'done' ? 'positive' : job.status === 'failed' ? 'danger' : 'warning'} size="sm">
                {copy.statuses[job.status] ?? job.status}
              </Badge>
              <span className="font-mono text-2xs text-ink-faint">{job.job_id}</span>
              {job.degraded ? (
                <Badge tone="warning" size="sm" icon="warning">{copy.degraded}</Badge>
              ) : null}
              {job.demo ? <LocaleDemoBadge locale={session.locale} /> : null}
            </div>

            <ol className="mb-4 flex flex-wrap items-center gap-2">
              {stages.map((stage, index) => (
                <li key={stage.key} className="flex items-center gap-2">
                  <span
                    className={
                      stage.state === 'done'
                        ? 'inline-flex items-center gap-1 rounded-full border border-positive/60 bg-positive-soft px-2.5 py-1 text-2xs text-positive'
                        : stage.state === 'active'
                          ? 'inline-flex items-center gap-1 rounded-full border border-accent bg-accent-soft px-2.5 py-1 text-2xs text-accent'
                          : stage.state === 'failed'
                            ? 'inline-flex items-center gap-1 rounded-full border border-danger/60 bg-danger-soft px-2.5 py-1 text-2xs text-danger'
                            : 'inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-2xs text-ink-faint'
                    }
                  >
                    <Icon name={stage.state === 'done' ? 'check' : stage.state === 'failed' ? 'warning' : 'clock'} size={11} />
                    {copy.stages[stage.key] ?? stage.key}
                  </span>
                  {index < stages.length - 1 ? <Icon name="chevronRight" size={11} className="text-ink-faint" /> : null}
                </li>
              ))}
            </ol>

            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCell label={copy.source} value={job.source_ref ?? job.source_type ?? dict.console.common.notStated} read={read} locale={session.locale} />
              <MetricCell label={copy.documents} value={job.documents === null ? '—' : String(job.documents)} read={read} locale={session.locale} />
              <MetricCell label={copy.chunks} value={job.chunks === null ? '—' : String(job.chunks)} read={read} locale={session.locale} />
              <MetricCell
                label={copy.proposalsTitle}
                value={counts ? `${counts.total} · ${counts.lowConfidence} ${copy.lowConfidence} · ${counts.withoutEvidence} ${copy.withoutEvidence}` : '—'}
                read={read}
                locale={session.locale}
              />
            </div>

            {job.error ? (
              <p className="mb-3 flex items-start gap-2 rounded-md border border-danger/60 bg-danger-soft px-3 py-2 text-xs text-danger">
                <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
                {job.error}
              </p>
            ) : null}

            <ConsoleTable
              caption={copy.proposalsTitle}
              head={[copy.columns.name, copy.columns.kind, copy.columns.price, copy.columns.confidence, copy.columns.evidence, copy.columns.span, copy.confirmProposal]}
              rows={job.proposals.map((proposal) => [
                <span key="n" className="font-medium">{proposal.name}</span>,
                <span key="k" className="text-2xs text-ink-muted">{proposal.kind}</span>,
                <span key="p" className="font-mono text-2xs">
                  {proposal.price ? formatMoney(proposal.price, dict.locale) : dict.console.common.notStated}
                </span>,
                <span key="c" className="flex items-center gap-1.5">
                  <span className="font-mono text-2xs">{proposal.confidence === null ? '—' : proposal.confidence.toFixed(2)}</span>
                  {proposalIsLowConfidence(proposal) ? <Badge tone="warning" size="sm">{copy.lowConfidence}</Badge> : null}
                </span>,
                <span key="e" className="text-2xs">
                  {proposal.evidence_fact_ids.length > 0 ? (
                    <span className="font-mono">{proposal.evidence_fact_ids.length}</span>
                  ) : (
                    <Badge tone="danger" size="sm">{copy.withoutEvidence}</Badge>
                  )}
                </span>,
                <span key="s" className="max-w-[14rem] text-2xs text-ink-muted">{proposal.source_span ?? '—'}</span>,
                <ConfirmAction
                  key="a"
                  locale={session.locale}
                  endpoint={PROPOSAL_ENDPOINT}
                  label={copy.confirmProposal}
                  confirmTitle={copy.confirmTitle}
                  confirmText={copy.confirmText(proposal.name)}
                  variant="outline"
                  size="xs"
                />,
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.empty}</p>}
            />
            <SourceStamp read={read} locale={session.locale} className="mt-3" />
          </>
        ) : null}
      </ConsoleSection>
    </MerchantChrome>
  );
}

export const dynamic = 'force-dynamic';
