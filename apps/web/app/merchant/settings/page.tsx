import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Icon } from '@nexus/ui';

import { merchantBySlug } from '@/lib/data';
import { formatMoney, weekdayLabel } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { knowledgeSummary, verificationStateOf } from '@/lib/console-shared';
import {
  merchantAgentConfigRead,
  merchantApiKeysRead,
  merchantKnowledgeRead,
  merchantMembersRead,
  merchantOverviewRead,
} from '@/lib/console-merchant';
import { ConsoleSection, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConsoleTable } from '@/components/console/console-table';
import { ConfirmAction } from '@/components/console/confirm-action';
import { AgentConfigForm } from '@/components/console/agent-config-form';
import { MerchantChrome, MerchantSignInStop, merchantSession } from '@/components/console/merchant-shell';

const VERIFICATION_ENDPOINT = 'POST /api/v1/businesses/{id}/verification';
const MEMBERS_ENDPOINT = 'POST /api/v1/merchant/members';
const KEYS_ENDPOINT = 'POST /api/v1/merchant/api-keys';
const REINDEX_ENDPOINT = 'POST /api/v1/merchant/knowledge-base/reindex';

/** `/merchant/settings` — §5/§47/§48/§49: profile, hours, verification, agent, team, keys, knowledge. */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.nav.settings,
    description: dict.console.settings.intro,
    alternates: { canonical: '/merchant/settings' },
    robots: { index: false, follow: false },
  };
}

export default async function MerchantSettingsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await merchantSession(await props.searchParams);
  const dict = getDict(session.locale);
  const copy = dict.console.settings;
  if (session.blocked) return <MerchantSignInStop locale={session.locale} />;

  const businessId = session.businessId;
  const [overview, agent, members, keys, knowledge] = await Promise.all([
    merchantOverviewRead(businessId),
    merchantAgentConfigRead(businessId),
    merchantMembersRead(businessId),
    merchantApiKeysRead(businessId),
    merchantKnowledgeRead(businessId),
  ]);
  const page = overview.data ? await merchantBySlug(overview.data.slug) : null;
  const detail = page?.data?.detail ?? null;
  const verification = verificationStateOf(null);
  const knowledgeCounts = knowledgeSummary(knowledge.data ?? []);

  return (
    <MerchantChrome
      title={copy.title}
      intro={copy.intro}
      section={dict.console.nav.settings}
      active="/merchant/settings"
      locale={session.locale}
      demo={overview.origin === 'mock'}
    >
      <ConsoleSection id="profile" title={copy.profileTitle} icon="store">
        {overview.status === 'failed' ? (
          <ReadFailure read={overview} locale={session.locale} title={dict.merchant.degradedTitle} />
        ) : overview.data ? (
          <div className="flex flex-col gap-2">
            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex gap-2"><dt className="text-ink-faint">{dict.console.listings.fields.name}</dt><dd className="text-ink-strong">{overview.data.display_name}</dd></div>
              <div className="flex gap-2"><dt className="text-ink-faint">{dict.console.funnel.statusLabel}</dt><dd className="text-ink-strong">{overview.data.status}</dd></div>
              <div className="flex gap-2"><dt className="text-ink-faint">{dict.console.funnel.categoryLabel}</dt><dd className="text-ink-strong">{overview.data.category_primary ?? dict.console.common.notStated}</dd></div>
              <div className="flex gap-2"><dt className="text-ink-faint">{dict.console.listings.fields.phone}</dt><dd className="text-ink-strong">{detail?.locations[0]?.phone ?? dict.console.common.notStated}</dd></div>
              <div className="flex gap-2"><dt className="text-ink-faint">{dict.console.listings.fields.price_amount}</dt><dd className="text-ink-strong">{detail?.avg_price ? formatMoney(detail.avg_price, dict.locale) : dict.console.common.notStated}</dd></div>
              <div className="flex gap-2"><dt className="text-ink-faint">{dict.console.listings.fields.tagline}</dt><dd className="text-ink-strong">{detail?.tagline ?? dict.console.common.notStated}</dd></div>
            </dl>
            <Link
              href={`/merchant/listings${session.requested ? `?business=${encodeURIComponent(session.requested)}` : ''}`}
              className="inline-flex w-fit items-center gap-1 rounded-full border border-accent bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent-line/60"
            >
              <Icon name="settings" size={13} />
              {dict.console.listings.editCta}
            </Link>
            <SourceStamp read={overview} locale={session.locale} />
          </div>
        ) : null}
      </ConsoleSection>

      <ConsoleSection id="hours" title={copy.hoursTitle} note={copy.hoursNote} icon="clock">
        {detail && detail.business_hours.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs">
            {detail.business_hours.map((day) => (
              <li key={day.weekday} className="flex items-center gap-3">
                <span className="w-20 text-ink-muted">{weekdayLabel(day.weekday, dict.locale) || String(day.weekday)}</span>
                <span className="font-mono text-ink-strong">
                  {day.closed || !day.ranges || day.ranges.length === 0
                    ? dict.merchant.closedNow
                    : day.ranges.map((range) => `${range.open}–${range.close}`).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">{dict.console.common.notStated}</p>
        )}
        <p className="mt-2 text-2xs text-ink-faint">{dict.merchant.hoursFact}</p>
      </ConsoleSection>

      <ConsoleSection id="verification" title={copy.verificationTitle} icon="shield">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={verification === 'verified' ? 'positive' : verification === 'pending' ? 'warning' : 'neutral'} size="sm">
            {copy.verification[verification]}
          </Badge>
        </div>
        <p className="mt-2 max-w-3xl text-2xs leading-relaxed text-ink-muted">{copy.verification.note}</p>
        <div className="mt-3">
          <ConfirmAction
            locale={session.locale}
            endpoint={VERIFICATION_ENDPOINT}
            label={copy.verification.request}
            confirmTitle={copy.verification.request}
            confirmText={copy.verification.notWired}
            variant="outline"
            size="sm"
          />
        </div>
      </ConsoleSection>

      <ConsoleSection id="agent" title={copy.agentTitle} note={copy.agentIntro} icon="ai">
        <AgentConfigForm locale={session.locale} initial={agent.data} bffPath={undefined} />
        <SourceStamp read={agent} locale={session.locale} className="mt-3" />
      </ConsoleSection>

      <ConsoleSection id="team" title={copy.teamTitle} icon="users">
        {members.status === 'failed' ? (
          <ReadFailure read={members} locale={session.locale} title={dict.merchant.degradedTitle} />
        ) : (
          <>
            <ConsoleTable
              caption={copy.teamTitle}
              head={[copy.team.columns.name, copy.team.columns.email, copy.team.columns.role, copy.team.columns.permissions, copy.team.columns.status, copy.team.columns.joined]}
              rows={(members.data ?? []).map((member) => [
                <span key="n" className="font-medium">{member.name ?? '—'}</span>,
                <span key="e" className="font-mono text-2xs">{member.email ?? '—'}</span>,
                <Badge key="r" tone="neutral" size="sm">{member.role}</Badge>,
                <span key="p" className="font-mono text-2xs text-ink-faint">{member.permissions.join(', ') || '—'}</span>,
                <span key="s" className="text-2xs">{member.status ?? dict.console.common.notStated}</span>,
                <span key="j" className="font-mono text-2xs text-ink-faint">{member.created_at ?? '—'}</span>,
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.team.empty}</p>}
            />
            <div className="mt-3">
              <ConfirmAction
                locale={session.locale}
                endpoint={MEMBERS_ENDPOINT}
                label={copy.team.invite}
                confirmTitle={copy.team.invite}
                confirmText={copy.team.notWired}
                variant="outline"
                size="sm"
              />
            </div>
            <SourceStamp read={members} locale={session.locale} className="mt-2" />
          </>
        )}
      </ConsoleSection>

      <ConsoleSection id="keys" title={copy.keysTitle} icon="lock">
        {keys.status === 'failed' ? (
          <ReadFailure read={keys} locale={session.locale} title={dict.merchant.degradedTitle} />
        ) : (
          <>
            <ConsoleTable
              caption={copy.keysTitle}
              head={[copy.keys.columns.label, copy.keys.columns.prefix, copy.keys.columns.scopes, copy.keys.columns.created, copy.keys.columns.lastUsed, copy.keys.columns.revoked]}
              rows={(keys.data ?? []).map((key) => [
                <span key="l" className="font-medium">{key.label}</span>,
                <span key="p" className="font-mono text-2xs">{key.prefix ?? '—'}</span>,
                <span key="s" className="font-mono text-2xs text-ink-faint">{key.scopes.join(', ') || '—'}</span>,
                <span key="c" className="font-mono text-2xs text-ink-faint">{key.created_at ?? '—'}</span>,
                <span key="u" className="font-mono text-2xs text-ink-faint">{key.last_used_at ?? '—'}</span>,
                <span key="r" className="text-2xs">{key.revoked_at ? <Badge tone="danger" size="sm">{copy.keys.columns.revoked}</Badge> : '—'}</span>,
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.keys.empty}</p>}
            />
            <p className="mt-2 text-2xs text-ink-faint">{copy.keys.onceNote}</p>
            <div className="mt-3">
              <ConfirmAction
                locale={session.locale}
                endpoint={KEYS_ENDPOINT}
                label={copy.keys.create}
                confirmTitle={copy.keys.create}
                confirmText={copy.keys.notWired}
                variant="outline"
                size="sm"
              />
            </div>
            <SourceStamp read={keys} locale={session.locale} className="mt-2" />
          </>
        )}
      </ConsoleSection>

      <ConsoleSection id="knowledge" title={copy.knowledgeTitle} note={copy.knowledgeIntro} icon="layers">
        {knowledge.status === 'failed' ? (
          <ReadFailure read={knowledge} locale={session.locale} title={dict.merchant.degradedTitle} />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-2xs text-ink-muted">
              <Badge tone="neutral" size="sm">{copy.knowledge.documents}: {knowledgeCounts.documents}</Badge>
              <Badge tone="neutral" size="sm">{copy.knowledge.chunksTotal}: {knowledgeCounts.chunks ?? dict.console.common.notStated}</Badge>
              <Badge tone="positive" size="sm">{copy.knowledge.indexed}: {knowledgeCounts.indexed}</Badge>
              <Badge tone="warning" size="sm">{copy.knowledge.awaiting}: {knowledgeCounts.awaitingIndex}</Badge>
              {knowledgeCounts.failed > 0 ? <Badge tone="danger" size="sm">{copy.knowledge.failed}: {knowledgeCounts.failed}</Badge> : null}
            </div>
            <ConsoleTable
              caption={copy.knowledgeTitle}
              head={[copy.knowledge.columns.kind, copy.knowledge.columns.title, copy.knowledge.columns.status, copy.knowledge.columns.chunks, copy.knowledge.columns.updated]}
              rows={(knowledge.data ?? []).map((document) => [
                <span key="k" className="text-2xs text-ink-muted">{document.kind ?? '—'}</span>,
                <span key="t" className="font-medium">
                  {document.title ?? document.id}
                  {document.source_uri ? <span className="ml-2 font-mono text-2xs text-ink-faint">{document.source_uri}</span> : null}
                </span>,
                <Badge key="s" tone={document.status === 'indexed' ? 'positive' : document.status === 'failed' ? 'danger' : 'warning'} size="sm">
                  {copy.knowledge.statuses[document.status] ?? document.status}
                </Badge>,
                <span key="c" className="font-mono text-2xs">{document.chunk_count ?? '—'}</span>,
                <span key="u" className="font-mono text-2xs text-ink-faint">{document.updated_at ?? '—'}</span>,
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.knowledge.empty}</p>}
            />
            <div className="mt-3">
              <ConfirmAction
                locale={session.locale}
                endpoint={REINDEX_ENDPOINT}
                baseBody={{ merchant_id: businessId }}
                label={copy.knowledge.reindex}
                confirmTitle={copy.knowledge.reindex}
                confirmText={copy.knowledge.notWired}
                variant="outline"
                size="sm"
              />
            </div>
            <SourceStamp read={knowledge} locale={session.locale} className="mt-2" />
          </>
        )}
      </ConsoleSection>
    </MerchantChrome>
  );
}

export const dynamic = 'force-dynamic';
