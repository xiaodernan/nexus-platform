import { Container, Skeleton } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * Console segment skeleton. Root `app/loading.tsx` is forbidden in this project (it flushes the
 * shell at HTTP 200 and turns every `notFound()` into a soft 404); a skeleton is legal only inside
 * a segment that decides its own status first — and the console pages never call `notFound()`,
 * they degrade or render the sign-in state, so a loading boundary below `/merchant` is safe.
 */
export default async function MerchantConsoleLoading() {
  const dict = getDict(await currentLocale());
  return (
    <Container size="wide" className="flex flex-col gap-6 py-10" aria-busy>
      <span role="status" className="sr-only">
        {dict.states.loading}
      </span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-full max-w-2xl" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-28 w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-48 w-full rounded-lg" />
    </Container>
  );
}
