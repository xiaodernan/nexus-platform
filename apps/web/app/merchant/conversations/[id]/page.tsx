import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Icon } from '@nexus/ui';

import { formatDateTime } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { messageIsAiAuthored } from '@/lib/console-shared';
import { merchantThreadRead } from '@/lib/console-merchant';
import { LocaleDemoBadge } from '@/components/locale-badges';
import { ConsoleSection, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConfirmAction } from '@/components/console/confirm-action';
import { MerchantChrome, MerchantSignInStop, merchantSession } from '@/components/console/merchant-shell';

const HANDOFF_ENDPOINT = 'POST /api/v1/conversations/{id}/handoff-resolve';

/**
 * One conversation (§7 `GET /api/v1/conversations/{id}`). §108 is enforced in the rendering: a turn
 * the AI produced is labelled as AI-authored, and its `agent_run_id` is shown so the audit link back
 * to the run is visible rather than implied. A degraded turn says so.
 */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.nav.conversations,
    description: dict.console.sections.conversations,
    alternates: { canonical: '/merchant/conversations' },
    robots: { index: false, follow: false },
  };
}

export default async function MerchantThreadPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, search] = await Promise.all([props.params, props.searchParams]);
  const session = await merchantSession(search);
  const dict = getDict(session.locale);
  const copy = dict.console.conversations;
  if (session.blocked) return <MerchantSignInStop locale={session.locale} />;

  const thread = await merchantThreadRead(id);
  const detail = thread.data;
  const openHandoff = detail?.handoffs.some((handoff) => handoff.status === 'open') ?? false;

  return (
    <MerchantChrome
      title={detail?.consumer_name ?? copy.subjectFallback}
      intro={dict.console.sections.conversations}
      section={dict.console.nav.conversations}
      active="/merchant/conversations"
      locale={session.locale}
      demo={thread.origin === 'mock'}
    >
      <Link
        href={`/merchant/conversations${session.requested ? `?business=${encodeURIComponent(session.requested)}` : ''}`}
        className="inline-flex w-fit items-center gap-1 text-xs text-ink-muted hover:text-accent"
      >
        <Icon name="arrowLeft" size={13} />
        {dict.console.nav.conversations}
      </Link>

      {thread.status === 'failed' ? (
        <ReadFailure read={thread} locale={session.locale} title={dict.merchant.degradedTitle} />
      ) : detail ? (
        <>
          <ConsoleSection id="turns" title={dict.console.sections.conversations} icon="mail">
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <Badge tone="neutral" size="sm">
                {copy.modeLabel}: {copy.modes[detail.mode] ?? detail.mode}
              </Badge>
              <Badge tone={detail.status === 'handoff' ? 'danger' : 'accent'} size="sm">
                {copy.statuses[detail.status] ?? detail.status}
              </Badge>
              {detail.demo ? <LocaleDemoBadge locale={session.locale} /> : null}
            </div>

            <ul className="flex flex-col gap-2">
              {detail.messages.map((message) => {
                const ai = messageIsAiAuthored(message);
                return (
                  <li
                    key={message.id}
                    className={
                      ai
                        ? 'flex flex-col gap-1.5 rounded-lg border border-line bg-surface-muted p-3'
                        : 'flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3'
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{message.role}</span>
                      {ai ? (
                        <Badge tone="accent" size="sm" icon="ai">
                          {dict.console.reviews.aiGenerated}
                        </Badge>
                      ) : null}
                      {message.degraded ? (
                        <Badge tone="warning" size="sm" icon="warning">
                          {dict.search.degraded}
                        </Badge>
                      ) : null}
                      <span className="font-mono text-2xs text-ink-faint">{formatDateTime(message.created_at, dict.locale) ?? '—'}</span>
                    </div>
                    <p className="max-w-3xl text-sm leading-relaxed text-ink-strong">{message.content}</p>
                    {message.agent_run_id || message.fact_ids.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs text-ink-faint">
                        {message.agent_run_id ? <span>run {message.agent_run_id}</span> : null}
                        {message.fact_ids.length > 0 ? <span>{dict.search.citations(message.fact_ids.length)}</span> : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <SourceStamp read={thread} locale={session.locale} className="mt-3" />
          </ConsoleSection>

          {detail.handoffs.length > 0 ? (
            <ConsoleSection id="handoff" title={copy.handoffOpen} icon="bell">
              <ul className="mb-3 flex flex-col gap-2">
                {detail.handoffs.map((handoff) => (
                  <li key={handoff.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-line bg-surface px-3 py-2 text-2xs text-ink-muted">
                    <Badge tone={handoff.status === 'open' ? 'warning' : 'positive'} size="sm">
                      {handoff.status ?? '—'}
                    </Badge>
                    <span>{handoff.reason ?? dict.console.common.notStated}</span>
                    <span className="font-mono">{handoff.created_at ?? '—'}</span>
                    {handoff.resolved_at ? <span className="font-mono">→ {handoff.resolved_at}</span> : null}
                  </li>
                ))}
              </ul>
              {openHandoff ? (
                <ConfirmAction
                  locale={session.locale}
                  endpoint={HANDOFF_ENDPOINT}
                  choice={{
                    key: 'action',
                    label: copy.statusLabel,
                    options: [
                      { value: 'accepted', label: copy.statuses.handoff ?? 'handoff' },
                      { value: 'resolved', label: copy.statuses.closed ?? 'closed' },
                    ],
                  }}
                  label={copy.handoffOpen}
                  confirmTitle={copy.handoffOpen}
                  confirmText={dict.console.notWiredText}
                  variant="primary"
                  size="sm"
                />
              ) : (
                <p className="text-sm text-ink-muted">{copy.statuses.closed}</p>
              )}
            </ConsoleSection>
          ) : null}
        </>
      ) : null}
    </MerchantChrome>
  );
}

export const dynamic = 'force-dynamic';
