import type { Metadata } from 'next';
import { Badge } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { adminUsersRead } from '@/lib/console-admin';
import { ConsoleSection, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConsoleTable } from '@/components/console/console-table';
import { AdminChrome, AdminDenied, adminSession } from '@/components/console/admin-shell';

/**
 * `/admin/users` — §3/§68. §9 documents a `GET /api/v1/admin/users` list, but the platform serves
 * only the single-user support read (`GET /api/v1/users/{id}`), so live mode says exactly that
 * instead of rendering an empty table that would read as "no users exist".
 */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.adminConsole.usersTitle,
    description: dict.console.adminConsole.usersIntro,
    alternates: { canonical: '/admin/users' },
    robots: { index: false, follow: false },
  };
}

export default async function AdminUsersPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.console.adminConsole.users;

  const access = await adminSession();
  if (!access.granted) return <AdminDenied access={access} locale={locale} />;

  const read = await adminUsersRead();
  const rows = read.data ?? [];

  return (
    <AdminChrome
      title={dict.console.adminConsole.usersTitle}
      intro={dict.console.adminConsole.usersIntro}
      section={dict.console.nav.users}
      active="/admin/users"
      locale={locale}
      access={access}
    >
      <ConsoleSection id="users" title={dict.console.adminConsole.usersTitle} icon="users">
        {read.status === 'failed' ? (
          <div className="flex flex-col gap-2">
            <p className="max-w-3xl text-xs leading-relaxed text-ink-muted">{copy.listUnavailable}</p>
            <ReadFailure read={read} locale={locale} title={dict.merchant.degradedTitle} />
          </div>
        ) : (
          <>
            <ConsoleTable
              caption={dict.console.adminConsole.usersTitle}
              head={[copy.columns.name, copy.columns.email, copy.columns.locale, copy.columns.roles, copy.columns.created]}
              rows={rows.map((row) => [
                <span key="n" className="font-medium">{row.display_name}</span>,
                <span key="e" className="font-mono text-2xs">{row.email ?? '—'}</span>,
                <span key="l" className="font-mono text-2xs text-ink-faint">{row.locale ?? '—'}</span>,
                <span key="r" className="flex flex-wrap gap-1">
                  {row.roles.length > 0 ? (
                    row.roles.map((role) => (
                      <Badge key={role} tone="neutral" size="sm">{role}</Badge>
                    ))
                  ) : (
                    <span className="text-2xs text-ink-faint">{dict.console.common.notStated}</span>
                  )}
                </span>,
                <span key="c" className="font-mono text-2xs text-ink-faint">{row.created_at ?? '—'}</span>,
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.empty}</p>}
            />
            <p className="mt-2 max-w-3xl text-2xs leading-relaxed text-ink-faint">{copy.detailNote}</p>
            <SourceStamp read={read} locale={locale} className="mt-2" />
          </>
        )}
      </ConsoleSection>
    </AdminChrome>
  );
}

export const dynamic = 'force-dynamic';
