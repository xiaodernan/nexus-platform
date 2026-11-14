import type { Metadata } from 'next';

import { Badge, Container, Icon } from '@nexus/ui';

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
 *
 * Composition: two panels on large screens — the left one is the brand promise (the tagline as a
 * display line, plus the three HK-local proof points the hero makes on `/`), anchored by the same
 * accent glow language the console identity panels use. The right panel is the working card.
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
    <main className="mx-auto grid min-h-[70vh] w-full max-w-5xl items-center gap-10 overflow-x-clip px-6 py-14 lg:grid-cols-[1.15fr_1fr] lg:gap-14">
      {/* --------------------------------------------- left: the promise */}
      <section className="relative flex min-h-[24rem] flex-col justify-center gap-6 lg:gap-7">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-16 top-1/4 h-64 w-64 lg:-left-24 lg:h-72 lg:w-72"
          style={{ background: 'radial-gradient(closest-side, rgb(var(--nexus-accent-rgb) / 0.14), transparent)' }}
        />
        <span className="relative flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <Icon name="layers" size={17} />
          </span>
          <span className="text-sm font-semibold tracking-tight text-ink-strong">{dict.brand.name}</span>
        </span>
        <h1 className="relative max-w-[22ch] text-3xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-4xl">
          {dict.brand.tagline}
        </h1>
        <div className="relative flex flex-col gap-2">
          <span className="text-2xs font-medium uppercase tracking-[0.2em] text-ink-faint">{dict.signin.proofsTitle}</span>
          <ul className="flex max-w-prose flex-col gap-3">
            {dict.signin.proofs.map((proof) => (
              <li key={proof.title} className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <Icon name="check" size={12} />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold leading-snug text-ink-strong">{proof.title}</span>
                  <span className="text-xs leading-relaxed text-ink-muted">{proof.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative max-w-prose text-2xs leading-relaxed text-ink-faint">{dict.home.sourceNote}</p>
      </section>

      {/* ------------------------------------------ right: the working card */}
      <section className="relative w-full overflow-hidden rounded-xl border border-line bg-surface shadow-md">
        {/* brand rail — a one-pixel accent seam echoing the console strip */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-1"
          style={{ background: 'var(--nexus-ai-gradient)' }}
        />
        <Container size="narrow" className="relative flex flex-col gap-6 px-6 py-6 sm:px-8 sm:py-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent lg:hidden">{dict.brand.name}</span>
            <span className="hidden lg:inline" />
            <Badge tone="neutral" size="sm">{dict.signin.title}</Badge>
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-ink-strong">{dict.signin.title}</h2>
            <p className="text-sm leading-relaxed text-ink-muted">{dict.signin.intro}</p>
          </div>
          <SignInActions locale={locale} />
        </Container>
      </section>
    </main>
  );
}
