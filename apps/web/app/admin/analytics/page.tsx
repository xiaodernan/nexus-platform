import type { Metadata } from 'next';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { ConsoleNav, adminNavItems } from '@/components/console/console-nav';
import { AdminAnalyticsClient } from '@/components/admin-analytics';

/** `/admin/analytics` — the password-123 behavior view: dict-owned copy, one nav landmark, noindex. */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.adminAnalytics.title,
    description: dict.adminAnalytics.intro,
    alternates: { canonical: '/admin/analytics' },
    robots: { index: false, follow: false },
  };
}

export default async function AdminAnalyticsPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <ConsoleNav items={adminNavItems(locale)} active="/admin/analytics" label={dict.console.nav.analytics} />
      <AdminAnalyticsClient copy={dict.adminAnalytics} />
    </div>
  );
}
