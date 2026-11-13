import { Container } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * Loading boundary for `/[city]/[category]` (ƒ) — the category listing routes bucket the same
 * catalog as `/[city]`, one level deeper (city × category × price facets); a full catalog scan
 * blocks the first paint. This boundary renders the same landing shape. Decorative layers
 * `aria-hidden="true"`; `dict.states.loading` is the only copy. Motion-reduce collapses
 * every shimmer bar to `animate-none`.
 */
export default async function CategoryLoading() {
  const locale = await currentLocale();
  const dict = getDict(locale);

  const shimmer = 'bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none';

  return (
    <>
      <span role="status" className="sr-only">{dict.states.loading}</span>

      <section aria-hidden="true" className="py-8 sm:py-12">
        <Container size="shell" className="flex flex-col gap-5">
          <div className={`h-4 w-64 rounded ${shimmer}`} />
          <div className={`h-10 w-full max-w-xl rounded ${shimmer}`} style={{ animationDelay: '0.1s' }} />
          <div className={`h-4 w-3/4 max-w-lg rounded ${shimmer}`} style={{ animationDelay: '0.22s' }} />
          <div className="flex flex-wrap gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className={`h-8 w-28 rounded-full ${shimmer}`} style={{ animationDelay: `${i * 0.06}s` }} />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex flex-col gap-3 overflow-hidden rounded-xl border border-line bg-surface p-3 shadow-xs">
                <div className="relative h-36 w-full overflow-hidden rounded-lg bg-line/50">
                  <div className="absolute inset-y-0 left-0 w-1/3 bg-ink/5 [animation:nexus-shimmer_1.4s_ease-in-out_infinite] motion-reduce:animate-none" style={{ animationDelay: `${i * 0.12}s` }} />
                </div>
                <div className={`h-4 w-3/4 rounded ${shimmer}`} />
                <div className={`h-3 w-1/2 rounded ${shimmer}`} style={{ animationDelay: '0.2s' }} />
                <div className={`h-3 w-2/3 rounded ${shimmer}`} style={{ animationDelay: '0.35s' }} />
              </div>
            ))}
          </div>
        </Container>
      </section>
    </>
  );
}
