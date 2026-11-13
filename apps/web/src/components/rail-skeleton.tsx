/**
 * The fallback painted by each rail's `<Suspense>` boundary on the streamed home page (D1032).
 *
 * Deliberately identical in rhythm to the rail itself — heading bar, five card skeletons — so a
 * skeleton replacing data as it streams causes zero layout jank. `aria-hidden` on every decorative
 * layer; one sr-only `dict.states.loading` caption announces the state; every shimmer collapses
 * to `animate-none` under prefers-reduced-motion. No facts are rendered — the skeleton is not a
 * card (§155 by construction).
 */
import { Container } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

export default async function RailSkeleton() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const shimmer = 'bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none';

  return (
    <section aria-hidden="true" className="py-7 sm:py-8">
      <span role="status" className="sr-only">{dict.states.loading}</span>
      <Container size="shell" className="flex flex-col gap-5">
        {/* rail title bar */}
        <div className="flex flex-col gap-2">
          <div className={`h-7 w-48 rounded ${shimmer}`} />
          <div className={`h-4 w-72 rounded ${shimmer}`} style={{ animationDelay: '0.15s' }} />
        </div>
        {/* five rail cards, same shape as the real render */}
        <div className="rail-scroll -mx-4 flex gap-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex w-56 shrink-0 flex-col gap-2 overflow-hidden rounded-xl border border-line bg-surface p-3">
              <div className="relative h-32 w-full overflow-hidden rounded-lg bg-line/50">
                <div className="absolute inset-y-0 left-0 w-1/3 bg-ink/5 [animation:nexus-shimmer_1.4s_ease-in-out_infinite] motion-reduce:animate-none" style={{ animationDelay: `${i * 0.12}s` }} />
              </div>
              <div className={`h-4 w-3/4 rounded ${shimmer}`} />
              <div className={`h-3 w-1/2 rounded ${shimmer}`} style={{ animationDelay: '0.2s' }} />
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
