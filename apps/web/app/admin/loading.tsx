import { Container, Skeleton } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * Admin segment skeleton — same rule as `app/merchant/loading.tsx`: only a segment that never
 * raises `notFound()` may carry a loading boundary (root-level `loading.tsx` is banned; the trap
 * was measured and fixed in this build).
 */
export default async function AdminLoading() {
  const dict = getDict(await currentLocale());
  return (
    <Container size="wide" className="flex flex-col gap-6 py-10" aria-busy>
      <span role="status" className="sr-only">
        {dict.states.loading}
      </span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-full max-w-2xl" />
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-40 w-full rounded-lg" />
        ))}
      </div>
    </Container>
  );
}
