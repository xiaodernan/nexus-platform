import Link from 'next/link';
import { cookies } from 'next/headers';
import { Badge, EmptyState, Icon } from '@nexus/ui';

import { SESSION_COOKIE } from '@/lib/env';
import { getDict } from '@/lib/i18n';
import { adminGate, type AdminAccess } from '@/lib/console-admin';
import { LocaleDemoBadge } from '../locale-badges';
import { ConsoleContainer, ConsoleDemoBanner, ConsolePageHeader, ReadFailure } from './console-parts';
import { ConsoleNav, adminNavItems } from './console-nav';

/**
 * The §68 identity gate, read once per page **before** any data read. It is the same cookie check
 * the other consoles use plus the documented `GET /api/v1/me` role read, and it fails closed: a role
 * it cannot read is `unverified`, which renders the permission state and never the data.
 *
 * Returned as a discriminated result so a page can stop early — the reads never run for a denied
 * caller, which is why this is a function and not just a component.
 */
export async function adminSession(): Promise<AdminAccess> {
  const jar = await cookies();
  const signedIn = Boolean(jar.get(SESSION_COOKIE)?.value);
  const cookieHeader = jar
    .getAll()
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('; ');
  return adminGate({ signedIn, cookieHeader: cookieHeader || null });
}

/** The denied states, rendered instead of the data. Each names what it actually knows (§105). */
export function AdminDenied({ access, locale }: { access: Extract<AdminAccess, { granted: false }>; locale: string }) {
  const dict = getDict(locale);
  const gate = dict.console.adminConsole.gate;

  if (access.reason === 'sign_in_required') {
    return (
      <ConsoleContainer>
        {/* §68's authority boundary, at the same designed idiom as the merchant sign-in stop:
            one EmptyState, dict-sourced copy, never the data behind the gate. */}
        <EmptyState
          icon="shield"
          title={gate.signIn}
          action={
            <Link
              href="/signin"
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:border-accent"
            >
              <Icon name="arrowRight" size={13} />
              {dict.signin.submit}
            </Link>
          }
          className="mt-8"
        />
      </ConsoleContainer>
    );
  }
  if (access.reason === 'forbidden') {
    return (
      <ConsoleContainer>
        {/* Same idiom, one tier down: the signed-in member lacks the platform role. Kept honest —
            no invented CTA: a role is granted by an operator, not by retrying this page. */}
        <EmptyState
          icon="shield"
          title={gate.forbidden(access.statedRole ?? dict.console.common.notStated)}
          className="mt-8"
        />
      </ConsoleContainer>
    );
  }
  return (
    <ConsoleContainer>
      <ReadFailure
        read={{ source: 'GET /api/v1/me', errorCode: access.errorCode, requestId: access.requestId }}
        locale={locale}
        title={gate.unverified(access.errorCode)}
      />
    </ConsoleContainer>
  );
}

/** The page chrome shared by every admin surface: header, nav, demo banner, role badge. */
export function AdminChrome({
  title,
  intro,
  section,
  active,
  locale,
  access,
  children,
}: {
  title: string;
  intro: string;
  section: string;
  active: string;
  locale: string;
  access: Extract<AdminAccess, { granted: true }>;
  children: React.ReactNode;
}) {
  const dict = getDict(locale);
  const gate = dict.console.adminConsole.gate;
  return (
    <ConsoleContainer>
      <ConsolePageHeader
        title={title}
        intro={intro}
        locale={locale}
        badges={
          <>
            {access.demo ? <LocaleDemoBadge locale={locale} /> : null}
            <Badge tone="outline" size="sm">{section}</Badge>
            <Badge tone="neutral" size="sm">
              {gate.roleLabel}: {access.role}
            </Badge>
          </>
        }
      />
      <ConsoleNav items={adminNavItems(locale)} active={active} label={dict.console.nav.admin} />
      {access.demo ? <ConsoleDemoBanner locale={locale} /> : null}
      {children}
    </ConsoleContainer>
  );
}
