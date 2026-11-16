import Link from 'next/link';
import { Container, Icon, buttonVariants } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * The 404 boundary resolves the reader's locale at request time — a Simplified-Chinese reader
 * who lands on a dead route is told why in the same script they were just reading in (D1276:
 * zh-CN / Traditional / en). Reading cookies() opts the boundary out of the build-time
 * prerender; 404s are rare and this keeps the one dead-end page honest for every locale.
 */
export default async function NotFound() {
  const locale = await currentLocale();
  const dict = getDict(locale);
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
