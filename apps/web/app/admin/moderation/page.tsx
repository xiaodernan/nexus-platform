import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { adminModerationCasesRead, moderationCounts, resolvableCases } from '@/lib/console-admin';
import type { ModerationCaseStatus } from '@/lib/console-shared';
import { ConsoleSection, MetricCell, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ModerationQueue } from '@/components/console/moderation-queue';
import { AdminChrome, AdminDenied, adminSession } from '@/components/console/admin-shell';

/** `/admin/moderation` — the §9/§127 case queue, with the decision + note resolve behind a confirm. */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.adminConsole.moderationTitle,
    description: dict.console.adminConsole.moderationIntro,
    alternates: { canonical: '/admin/moderation' },
    robots: { index: false, follow: false },
  };
}

function filterOf(raw: string | string[] | undefined): ModerationCaseStatus | 'all' {
  if (raw === 'resolved') return 'resolved';
  if (raw === 'all') return 'all';
  return 'open';
}

export default async function AdminModerationPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await props.searchParams;
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.console.adminConsole.moderation;

  const access = await adminSession();
  if (!access.granted) return <AdminDenied access={access} locale={locale} />;

  const filter = filterOf(search.status);
  const read = await adminModerationCasesRead({ status: filter });
  const cases = read.data ?? [];
  const counts = moderationCounts(cases);
  const actionable = resolvableCases(cases).length;

  const filters: Array<{ value: ModerationCaseStatus | 'all'; label: string }> = [
    { value: 'open', label: copy.filterOpen },
    { value: 'resolved', label: copy.filterResolved },
    { value: 'all', label: copy.filterAll },
  ];

  return (
    <AdminChrome
      title={dict.console.adminConsole.moderationTitle}
      intro={dict.console.adminConsole.moderationIntro}
      section={dict.console.nav.moderation}
      active="/admin/moderation"
      locale={locale}
      access={access}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{copy.filter}</span>
        {filters.map((entry) => (
          <Link
            key={entry.value}
            href={`/admin/moderation?status=${entry.value}`}
            className={
              entry.value === filter
                ? 'rounded-full border border-accent bg-accent-soft px-2.5 py-1 text-xs text-accent'
                : 'rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted hover:border-accent hover:text-accent'
            }
          >
            {entry.label}
          </Link>
        ))}
      </div>

      {read.status === 'failed' ? (
        <ReadFailure read={read} locale={locale} title={dict.merchant.degradedTitle} />
      ) : (
        <>
          <ConsoleSection id="counts" title={dict.console.adminConsole.moderationTitle} icon="shield">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCell label={dict.console.adminConsole.counters.openCases} value={String(counts.open)} read={read} locale={locale} />
              <MetricCell label={dict.console.adminConsole.counters.resolvable} value={String(actionable)} read={read} locale={locale} />
              <MetricCell label={copy.filterResolved} value={String(counts.resolved)} read={read} locale={locale} />
              <MetricCell label={copy.filterAll} value={String(counts.total)} read={read} locale={locale} />
            </div>
            <SourceStamp read={read} locale={locale} className="mt-2" />
          </ConsoleSection>

          <ConsoleSection id="cases" title={dict.console.nav.moderation} note={dict.console.adminConsole.moderationIntro} icon="list">
            {cases.length === 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-ink-muted">{copy.empty}</p>
                <SourceStamp read={read} locale={locale} />
              </div>
            ) : (
              <>
                <ModerationQueue cases={cases} locale={locale} bffPath={undefined} />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Badge tone="outline" size="sm">
                    {copy.noteHint}
                  </Badge>
                  <SourceStamp read={read} locale={locale} />
                </div>
              </>
            )}
          </ConsoleSection>
        </>
      )}
    </AdminChrome>
  );
}

export const dynamic = 'force-dynamic';
