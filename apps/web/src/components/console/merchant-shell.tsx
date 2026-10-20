import Link from 'next/link';
import { cookies } from 'next/headers';
import { Badge } from '@nexus/ui';

import { IS_MOCK, SESSION_COOKIE } from '@/lib/env';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { consoleDemoBusinesses, DEMO_CONSOLE_BUSINESS } from '@/lib/console-fixtures';
import { LocaleDemoBadge } from '../locale-badges';
import { ConsoleContainer, ConsoleDemoBanner, ConsolePageHeader, SignInRequired } from './console-parts';
import { ConsoleNav, merchantNavItems } from './console-nav';

/**
 * Identity for `app/merchant/**`. There is no login page yet, so this never fabricates a session:
 * live mode without the cookie stops at `SignInRequired` (the page renders the stop instead of
 * redirecting, so the surface stays reviewable), and mock mode states it is viewing a demo identity.
 */
export interface MerchantSession {
  locale: string;
  signedIn: boolean;
  /** The `?business=` id when one was requested, else null. */
  requested: string | null;
  /** The id the reads should use — the requested one, or the demo identity in mock mode. */
  businessId: string;
  /** True ⇒ this render must not issue live reads. */
  blocked: boolean;
}

export async function merchantSession(searchParams: Record<string, string | string[] | undefined>): Promise<MerchantSession> {
  const locale = await currentLocale();
  const requested = typeof searchParams.business === 'string' && searchParams.business ? searchParams.business : null;
  const jar = await cookies();
  const signedIn = Boolean(jar.get(SESSION_COOKIE)?.value);
  return {
    locale,
    signedIn,
    requested,
    businessId: requested ?? DEMO_CONSOLE_BUSINESS,
    blocked: !IS_MOCK && !signedIn,
  };
}

/** The business picker shown in demo mode, so every demo identity (and the empty one) is reachable. */
export function MerchantBusinessPicker({ locale, activeId }: { locale: string; activeId: string | null }) {
  const dict = getDict(locale);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{dict.console.businessPickerLabel}</span>
      {consoleDemoBusinesses().map((business) => (
        <Link
          key={business.id}
          href={`/merchant?business=${encodeURIComponent(business.id)}`}
          className={
            business.id === activeId
              ? 'rounded-full border border-accent bg-accent-soft px-2.5 py-1 text-xs text-accent'
              : 'rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted hover:border-accent hover:text-accent'
          }
        >
          {business.name}
        </Link>
      ))}
    </div>
  );
}

export function MerchantChrome({
  title,
  intro,
  section,
  active,
  locale,
  demo,
  children,
}: {
  title: string;
  intro: string;
  section: string;
  active: string;
  locale: string;
  demo: boolean;
  children: React.ReactNode;
}) {
  const dict = getDict(locale);
  return (
    <ConsoleContainer>
      <ConsolePageHeader
        title={title}
        intro={intro}
        locale={locale}
        badges={
          <>
            {demo ? <LocaleDemoBadge locale={locale} /> : null}
            <Badge tone="outline" size="sm">{section}</Badge>
          </>
        }
      />
      <ConsoleNav items={merchantNavItems(locale)} active={active} label={dict.console.nav.merchant} />
      {demo ? <ConsoleDemoBanner locale={locale} /> : null}
      {children}
    </ConsoleContainer>
  );
}

/** The honest stop for live mode with no session. */
export function MerchantSignInStop({ locale }: { locale: string }) {
  return (
    <ConsoleContainer>
      <SignInRequired locale={locale} />
    </ConsoleContainer>
  );
}
