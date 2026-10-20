import type { Metadata } from 'next';
import { Badge, Icon } from '@nexus/ui';

import { formatNumber } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { distributionShares, reviewEvidenceCoverage } from '@/lib/console-shared';
import { merchantReviewIntelRead } from '@/lib/console-merchant';
import { LocaleDemoBadge } from '@/components/locale-badges';
import { ConsoleSection, MetricCell, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { MerchantChrome, MerchantSignInStop, merchantSession } from '@/components/console/merchant-shell';

/**
 * `/merchant/reviews` — §54/§55 review intelligence. The §55 rule is rendered, not just honoured:
 * a summary that cites nothing says so, and each theme shows whether it cites anything at all.
 */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.nav.reviews,
    description: dict.console.reviews.intro,
    alternates: { canonical: '/merchant/reviews' },
    robots: { index: false, follow: false },
  };
}

export default async function MerchantReviewsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await merchantSession(await props.searchParams);
  const dict = getDict(session.locale);
  const copy = dict.console.reviews;
  if (session.blocked) return <MerchantSignInStop locale={session.locale} />;

  const intel = await merchantReviewIntelRead(session.businessId);
  const data = intel.data;
  const coverage = data ? reviewEvidenceCoverage(data) : null;
  const shares = data ? distributionShares(data.distribution) : [];
  const noSummary = intel.status === 'failed' && intel.errorCode === 'review_summary_not_found';

  return (
    <MerchantChrome
      title={copy.title}
      intro={copy.intro}
      section={dict.console.nav.reviews}
      active="/merchant/reviews"
      locale={session.locale}
      demo={intel.origin === 'mock'}
    >
      {intel.status === 'failed' && !noSummary ? (
        <ReadFailure read={intel} locale={session.locale} title={dict.merchant.degradedTitle} />
      ) : noSummary ? (
        <ConsoleSection id="none" title={copy.title} icon="star">
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-muted">{copy.noSummary}</p>
            <SourceStamp read={intel} locale={session.locale} />
          </div>
        </ConsoleSection>
      ) : data ? (
        <>
          <ConsoleSection id="summary" title={copy.summaryTitle} icon="ai">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent" size="sm" icon="ai">
                {copy.aiGenerated}
              </Badge>
              <Badge tone={data.provenance.reviewed_by_human ? 'positive' : 'warning'} size="sm">
                {data.provenance.reviewed_by_human ? copy.humanReviewed : copy.humanUnreviewed}
              </Badge>
              {data.demo ? <LocaleDemoBadge locale={session.locale} /> : null}
            </div>

            {data.summary ? (
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-strong">{data.summary}</p>
            ) : (
              <p className="mt-3 text-sm text-ink-muted">{copy.empty}</p>
            )}

            {coverage && !coverage.hasEvidence ? (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-warning/70 bg-warning-soft px-3 py-2 text-xs text-warning">
                <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
                {copy.noEvidence}
              </p>
            ) : null}

            {coverage && coverage.uncoveredThemes.length > 0 ? (
              <p className="mt-2 text-2xs text-warning">{copy.uncoveredThemes(coverage.uncoveredThemes.length)}</p>
            ) : null}

            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCell
                label={copy.ratingLabel}
                value={data.average_rating === null ? '—' : data.average_rating.toFixed(2)}
                read={intel}
                locale={session.locale}
              />
              <MetricCell
                label={copy.evidence(data.evidence_review_ids.length)}
                value={formatNumber(data.evidence_review_ids.length, dict.locale)}
                read={intel}
                locale={session.locale}
              />
              <MetricCell
                label={copy.model}
                value={data.model ?? dict.console.common.notStated}
                read={intel}
                locale={session.locale}
              />
              <MetricCell
                label={copy.generatedAt}
                value={data.generated_at ?? dict.console.common.notStated}
                read={intel}
                locale={session.locale}
              />
            </div>
            <SourceStamp read={intel} locale={session.locale} className="mt-2" />
          </ConsoleSection>

          <ConsoleSection id="themes" title={copy.themes} icon="list">
            {data.themes.length === 0 ? (
              <p className="text-sm text-ink-muted">{copy.empty}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.themes.map((theme) => (
                  <li key={theme.label} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-line bg-surface px-4 py-3">
                    <span className="text-sm font-medium text-ink-strong">{theme.label}</span>
                    <Badge tone={theme.sentiment === 'positive' ? 'positive' : theme.sentiment === 'negative' ? 'danger' : 'neutral'} size="sm">
                      {theme.sentiment}
                    </Badge>
                    <span className="text-2xs text-ink-muted">{copy.themeMentions(theme.mentions)}</span>
                    <span className="font-mono text-2xs text-ink-faint">
                      {theme.review_ids.length > 0 ? copy.evidence(theme.review_ids.length) : copy.noEvidence}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </ConsoleSection>

          <ConsoleSection id="distribution" title={copy.distribution} icon="trending">
            <ul className="flex flex-col gap-1.5">
              {shares.map((bucket) => (
                <li key={bucket.rating} className="flex items-center gap-3 text-xs">
                  <span className="w-6 font-mono text-ink-muted">{bucket.rating}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: bucket.share === null ? '0%' : `${Math.round(bucket.share * 100)}%` }}
                    />
                  </span>
                  <span className="w-24 text-right font-mono text-2xs text-ink-faint">
                    {bucket.count} · {bucket.share === null ? '—' : `${(bucket.share * 100).toFixed(0)}%`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-2xs text-ink-faint">{copy.unpublishedNote}</p>
          </ConsoleSection>
        </>
      ) : null}
    </MerchantChrome>
  );
}

export const dynamic = 'force-dynamic';
