import Link from 'next/link';
import { Container, Icon, buttonVariants } from '@nexus/ui';

import { DEFAULT_LOCALE } from '@/lib/env';
import { getDict } from '@/lib/i18n';

/**
 * Static by design: a 404 boundary must not depend on request-scoped state (Next may prerender it),
 * so the copy falls back to the market default locale rather than reading a cookie.
 */
const dict = getDict(DEFAULT_LOCALE);

export default function NotFound() {
  return (
    <Container size="shell" className="flex flex-col items-start gap-4 py-16 sm:py-24">
      <span className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">404</span>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-strong sm:text-3xl">{dict.merchant.notFoundTitle}</h1>
      <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{dict.merchant.notFoundText}</p>
      <div className="flex flex-wrap gap-2">
        <Link href="/search" className={buttonVariants({ variant: 'primary', size: 'md' })}>
          {dict.nav.search}
        </Link>
        <Link href="/" className={buttonVariants({ variant: 'outline', size: 'md' })}>
          {dict.brand.name}
        </Link>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-ink-faint">
        <Icon name="info" size={13} />
        {dict.facts.note}
      </p>
    </Container>
  );
}
