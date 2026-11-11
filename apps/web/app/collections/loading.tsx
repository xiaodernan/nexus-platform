import { Container, Skeleton } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * Collections segment skeleton — the page is a static-safe fetch and raises no `notFound()`,
 * so a boundary here cannot produce a soft 404. Mirrors the merchant/admin loading pattern:
 * `role="status"` for assistive tech, the same Skeleton primitives, dict copy, no copy invented.
 */
export default async function CollectionsLoading() {
  const dict = getDict(await currentLocale());
  return (
    <Container size="shell" className="flex flex-col gap-6 py-10" aria-busy>
      <span role="status" className="sr-only">
        {dict.states.loading}
      </span>
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-4 w-full max-w-2xl" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <Skeleton key={index} className="h-36 w-full rounded-lg" />
        ))}
      </div>
    </Container>
  );
}
