import type { Metadata } from 'next';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { SignInActions } from '@/components/signin-actions';

/**
 * `/signin` — the local sign-in desk for the demo plane.
 *
 * There is no password auth yet (§46/§48). This page is the honest stop for that: two seeded accounts
 * a reviewer can enter, plus an explicit sign-out. Live mode only grants access through the platform's
 * own `/api/v1/auth/demo` door, which is switched off by `nexus.demo.login-enabled=false`; when it is,
 * the page renders the refusal instead of any session button.
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
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-start justify-center gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-strong">{dict.signin.title}</h1>
        <p className="text-sm text-ink-muted">{dict.signin.intro}</p>
      </div>
      <SignInActions locale={locale} />
    </main>
  );
}
