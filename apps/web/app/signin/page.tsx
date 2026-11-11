import type { Metadata } from 'next';

import { Badge, Container } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { SignInActions } from '@/components/signin-actions';

/**
 * `/signin` — the local sign-in desk for the demo plane.
 *
 * There is no password auth yet (§46/§48). This page is the honest stop for that: two seeded accounts
 * a reviewer can enter, plus an explicit sign-out. Live mode only grants access through the platform's
 * own `/api/v1/auth/demo` door, which is switched off by `nexus.demo.login-enabled=false`; when it is,
 * the page renders the refusal instead of any session button. It renders as a single console-panel card
 * anchored by the brand wordmark + a one-line status line — a composition upgrade, not a new identity.
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.signin.title,
    description: dict.signin.intro,
    alternates: { canonical: '/signin' },
    robots: { index: false, follow: false },
  };
}

export default async function SignInPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-6 py-16">
      <div className="relative w-full overflow-hidden rounded-xl border border-line bg-surface shadow-md">
        {/* brand rail — a one-pixel accent seam echoing the console strip */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-1"
          style={{ background: 'var(--nexus-ai-gradient)' }}
        />
        <Container size="narrow" className="relative flex flex-col gap-6 px-6 py-6 sm:px-8 sm:py-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{dict.brand.name}</span>
            <Badge tone="neutral" size="sm">{dict.signin.title}</Badge>
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-ink-strong">{dict.signin.title}</h1>
            <p className="text-sm leading-relaxed text-ink-muted">{dict.signin.intro}</p>
          </div>
          <SignInActions locale={locale} />
        </Container>
      </div>
    </main>
  );
}
