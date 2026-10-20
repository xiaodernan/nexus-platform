import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@nexus/ui';

import { formatRelativeDay } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { threadNeedsHuman } from '@/lib/console-shared';
import { merchantInboxRead } from '@/lib/console-merchant';
import { LocaleDemoBadge } from '@/components/locale-badges';
import { ConsoleSection, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { MerchantChrome, MerchantSignInStop, merchantSession } from '@/components/console/merchant-shell';

/** `/merchant/conversations` — the §25/§26 inbox: AI-answered and handed-off threads, newest first. */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.nav.conversations,
    description: dict.console.sections.conversations,
    alternates: { canonical: '/merchant/conversations' },
    robots: { index: false, follow: false },
  };
}

export default async function MerchantConversationsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await merchantSession(await props.searchParams);
  const dict = getDict(session.locale);
  const copy = dict.console.conversations;
  if (session.blocked) return <MerchantSignInStop locale={session.locale} />;

  const inbox = await merchantInboxRead(session.businessId);
  const threads = inbox.data ?? [];

  return (
    <MerchantChrome
      title={dict.console.sections.conversations}
      intro={dict.console.sections.conversations}
      section={dict.console.nav.conversations}
      active="/merchant/conversations"
      locale={session.locale}
      demo={inbox.origin === 'mock'}
    >
      <ConsoleSection id="inbox" title={dict.console.sections.conversations} icon="mail">
        {inbox.status === 'failed' ? (
          <ReadFailure read={inbox} locale={session.locale} title={dict.merchant.degradedTitle} />
        ) : threads.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-muted">{copy.empty}</p>
            <SourceStamp read={inbox} locale={session.locale} />
          </div>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
              {threads.map((thread) => (
                <li key={thread.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/merchant/conversations/${encodeURIComponent(thread.id)}`}
                      className="truncate text-sm font-medium text-ink-strong hover:text-accent"
                    >
                      {thread.subject ?? copy.subjectFallback}
                    </Link>
                    <p className="text-2xs text-ink-faint">
                      {thread.consumer_name ?? '—'} · {copy.lastActivity}:{' '}
                      {thread.last_message_at ? formatRelativeDay(thread.last_message_at, dict.locale) : '—'}
                    </p>
                  </div>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral" size="sm">
                      {copy.modeLabel}: {copy.modes[thread.mode] ?? thread.mode}
                    </Badge>
                    <Badge tone={thread.status === 'handoff' ? 'danger' : thread.status === 'open' ? 'accent' : 'neutral'} size="sm">
                      {copy.statuses[thread.status] ?? thread.status}
                    </Badge>
                    {threadNeedsHuman(thread) ? (
                      <Badge tone="warning" size="sm" icon="bell">
                        {copy.handoffOpen}
                      </Badge>
                    ) : null}
                    {thread.demo ? <LocaleDemoBadge locale={session.locale} /> : null}
                  </span>
                </li>
              ))}
            </ul>
            <SourceStamp read={inbox} locale={session.locale} className="mt-2" />
          </>
        )}
      </ConsoleSection>
    </MerchantChrome>
  );
}

export const dynamic = 'force-dynamic';
