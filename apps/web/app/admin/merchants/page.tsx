import type { Metadata } from 'next';
import { Badge } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { adminMerchantsRead } from '@/lib/console-admin';
import { ConsoleSection, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConsoleTable } from '@/components/console/console-table';
import { ConfirmAction } from '@/components/console/confirm-action';
import { AdminChrome, AdminDenied, adminSession } from '@/components/console/admin-shell';

const SUSPEND_ENDPOINT = 'POST /api/v1/admin/merchants/{id}/suspend';

/**
 * `/admin/merchants` — the §9 merchant list with suspension. Suspension is destructive and
 * consumer-visible, so it requires a reason (written to the audit log) **and** a confirm step; it
 * never fires on mount. §9 documents `GET /api/v1/admin/merchants`, but no controller serves it in
 * this build, so a live read fails visibly instead of showing an empty table.
 */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.adminConsole.merchantsTitle,
    description: dict.console.adminConsole.merchantsIntro,
    alternates: { canonical: '/admin/merchants' },
    robots: { index: false, follow: false },
  };
}

export default async function AdminMerchantsPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.console.adminConsole.merchants;

  const access = await adminSession();
  if (!access.granted) return <AdminDenied access={access} locale={locale} />;

  const read = await adminMerchantsRead({ limit: 50 });
  const rows = read.data ?? [];

  return (
    <AdminChrome
      title={dict.console.adminConsole.merchantsTitle}
      intro={dict.console.adminConsole.merchantsIntro}
      section={dict.console.nav.merchants}
      active="/admin/merchants"
      locale={locale}
      access={access}
    >
      <ConsoleSection id="merchants" title={dict.console.adminConsole.merchantsTitle} icon="store">
        {read.status === 'failed' ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-ink-muted">{copy.listUnavailable}</p>
            <ReadFailure read={read} locale={locale} title={dict.merchant.degradedTitle} />
          </div>
        ) : (
          <>
            <ConsoleTable
              caption={dict.console.adminConsole.merchantsTitle}
              head={[
                copy.columns.name,
                copy.columns.slug,
                copy.columns.status,
                copy.columns.category,
                copy.columns.plan,
                copy.columns.rating,
                copy.columns.reviews,
                dict.console.adminConsole.merchants.suspend,
              ]}
              rows={rows.map((row) => [
                <span key="n" className="font-medium">{row.name}</span>,
                <span key="s" className="font-mono text-2xs text-ink-faint">{row.slug ?? '—'}</span>,
                <Badge key="st" tone={row.status === 'suspended' ? 'danger' : row.status === 'published' ? 'positive' : 'neutral'} size="sm">
                  {row.status ?? dict.console.common.notStated}
                </Badge>,
                <span key="c" className="text-2xs text-ink-muted">{row.category ?? '—'}</span>,
                <span key="p" className="text-2xs text-ink-muted">{row.plan ?? '—'}</span>,
                <span key="r" className="font-mono text-2xs">{row.rating ?? '—'}</span>,
                <span key="rc" className="font-mono text-2xs">{row.reviews ?? '—'}</span>,
                row.status === 'suspended' ? (
                  <span key="a" className="text-2xs text-ink-faint">{copy.alreadySuspended}</span>
                ) : (
                  <ConfirmAction
                    key="a"
                    locale={locale}
                    endpoint={SUSPEND_ENDPOINT}
                    note={{ key: 'reason', label: copy.suspendReason, hint: copy.suspendReasonHint, required: true, maxLength: 500 }}
                    label={copy.suspend}
                    confirmTitle={copy.suspendTitle}
                    confirmText={`${copy.suspendIntro} ${copy.effect}: ${copy.suspendNotWired}`}
                    variant="danger"
                    size="xs"
                  />
                ),
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.empty}</p>}
            />
            <SourceStamp read={read} locale={locale} className="mt-2" />
          </>
        )}
      </ConsoleSection>
    </AdminChrome>
  );
}

export const dynamic = 'force-dynamic';
