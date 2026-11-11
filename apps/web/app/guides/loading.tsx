import { Container, Skeleton } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * Guides segment skeleton — the guides index is a static-safe fetch and raises no `notFound()`.
 * Skeleton list mirrors the editorial card rhythm; no copy is invented anywhere.
 */
export default async function GuidesLoading() {
  const dict = getDict(await currentLocale());
  return (
    <Container size="shell" className="flex flex-col gap-6 py-10" aria-busy>
      <span role="status" className="sr-only">
        {dict.states.loading}
      </span>
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-4 w-full max-w-2xl" />
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-32 w-full rounded-lg" />
        ))}
      </div>
    </Container>
  );
}
