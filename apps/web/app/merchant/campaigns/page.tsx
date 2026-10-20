import type { Metadata } from 'next';
import { Badge, Icon } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { aiDraftState, campaignCounts, campaignPublishable } from '@/lib/console-shared';
import { merchantCampaignsRead } from '@/lib/console-merchant';
import { LocaleDemoBadge } from '@/components/locale-badges';
import { ConsoleSection, MetricCell, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConfirmAction } from '@/components/console/confirm-action';
import { MerchantChrome, MerchantSignInStop, merchantSession } from '@/components/console/merchant-shell';

const PUBLISH_ENDPOINT = 'POST /api/v1/merchant/campaigns/{id}/publish';

/**
 * `/merchant/campaigns` — §27 campaign drafts. The publish button is only offered when the §27 gate
 * is open (`campaignPublishable`): an AI draft no human has checked cannot be published from here,
 * and the page says why rather than showing a disabled button with no explanation.
 *
 * Contract gap: §5 documents the create and approve-publish writes but **no list read**, so a live
 * read fails visibly instead of pretending there are no drafts.
 */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.nav.campaigns,
    description: dict.console.campaigns.intro,
    alternates: { canonical: '/merchant/campaigns' },
    robots: { index: false, follow: false },
  };
}

export default async function MerchantCampaignsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await merchantSession(await props.searchParams);
  const dict = getDict(session.locale);
  const copy = dict.console.campaigns;
  if (session.blocked) return <MerchantSignInStop locale={session.locale} />;

  const read = await merchantCampaignsRead(session.businessId);
  const campaigns = read.data ?? [];
  const counts = campaignCounts(campaigns);

  return (
    <MerchantChrome
      title={copy.title}
      intro={copy.intro}
      section={dict.console.nav.campaigns}
      active="/merchant/campaigns"
      locale={session.locale}
      demo={read.origin === 'mock'}
    >
      <ConsoleSection id="campaigns" title={copy.title} note={copy.intro} icon="ticket">
        {read.status === 'failed' ? (
          <ReadFailure read={read} locale={session.locale} title={dict.merchant.degradedTitle} />
        ) : campaigns.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-muted">{copy.empty}</p>
            <SourceStamp read={read} locale={session.locale} />
          </div>
        ) : (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCell label={copy.columns.status} value={String(counts.total)} read={read} locale={session.locale} />
              <MetricCell label={dict.console.campaigns.statuses.draft ?? 'draft'} value={String(counts.drafts)} read={read} locale={session.locale} />
              <MetricCell label={dict.console.campaigns.statuses.published ?? 'published'} value={String(counts.published)} read={read} locale={session.locale} />
              <MetricCell label={copy.gateBlocked} value={String(counts.awaitingHuman)} read={read} locale={session.locale} />
            </div>

            <ul className="flex flex-col gap-3">
              {campaigns.map((campaign) => {
                const state = aiDraftState(campaign.provenance);
                const publishable = campaignPublishable(campaign);
                return (
                  <li key={campaign.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-ink-strong">{campaign.name}</span>
                      <Badge tone={campaign.status === 'published' ? 'positive' : campaign.status === 'draft' ? 'warning' : 'neutral'} size="sm">
                        {copy.statuses[campaign.status] ?? campaign.status}
                      </Badge>
                      <Badge tone="outline" size="sm">{campaign.channel}</Badge>
                      {state !== 'human' ? (
                        <Badge tone={state === 'ai_approved' ? 'positive' : 'warning'} size="sm" icon="ai">
                          {state === 'ai_approved' ? dict.console.reviews.humanReviewed : dict.console.reviews.humanUnreviewed}
                        </Badge>
                      ) : null}
                      {campaign.demo ? <LocaleDemoBadge locale={session.locale} /> : null}
                    </div>

                    {campaign.body ? <p className="max-w-3xl text-xs leading-relaxed text-ink-muted">{campaign.body}</p> : null}

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-ink-faint">
                      {campaign.audience ? <span>{copy.columns.audience}: {campaign.audience}</span> : null}
                      {campaign.approved_by ? <span>{dict.console.admin.actorLabel}: {campaign.approved_by}</span> : null}
                      <span>{copy.columns.created}: {campaign.created_at ?? '—'}</span>
                      {campaign.evidence_fact_ids.length > 0 ? (
                        <span>{copy.evidence}: {campaign.evidence_fact_ids.length}</span>
                      ) : null}
                    </div>

                    {publishable ? (
                      <ConfirmAction
                        locale={session.locale}
                        endpoint={PUBLISH_ENDPOINT}
                        label={copy.publish}
                        confirmTitle={copy.confirmTitle}
                        confirmText={copy.confirmText(campaign.name)}
                        variant="primary"
                        size="sm"
                      />
                    ) : (
                      <p className="flex max-w-3xl items-start gap-1.5 text-2xs leading-relaxed text-warning">
                        <Icon name="warning" size={12} className="mt-0.5 shrink-0" />
                        {campaign.status === 'draft' ? copy.gateBlocked : (copy.statuses[campaign.status] ?? campaign.status)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            <SourceStamp read={read} locale={session.locale} className="mt-3" />
          </>
        )}
      </ConsoleSection>
    </MerchantChrome>
  );
}

export const dynamic = 'force-dynamic';
