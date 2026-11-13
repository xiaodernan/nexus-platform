import { Container } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * Loading boundary for `/search` (ƒ) — the AI results route blocks on the full retrieval
 * round trip (§105 ladders: stream first, fallback here), so cold navigations painted a
 * blank canvas for a BFF hop we could not hide. This boundary renders a shape instead of a
 * wait. Decorative layers `aria-hidden="true"`; `dict.states.loading` is the only copy —
 * `aria-hidden` keeps shimmer bars out of the accessibility tree; motion-reduce collapses
 * every shimmer bar to `animate-none`.
 */
export default async function SearchLoading() {
  const locale = await currentLocale();
  const dict = getDict(locale);

  const shimmer = 'bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none';

  return (
    <>
      <span role="status" className="sr-only">{dict.states.loading}</span>

      <section aria-hidden="true" className="py-7">
        <Container size="shell" className="flex flex-col gap-5">
          {/* Answer bar + filter chips, shaped like the results meta line */}
          <div className="flex flex-wrap items-center gap-3">
            <div className={`h-8 w-56 rounded-full ${shimmer}`} />
            <div className={`h-7 w-44 rounded-full ${shimmer}`} style={{ animationDelay: '0.15s' }} />
            <div className={`h-7 w-36 rounded-full ${shimmer}`} style={{ animationDelay: '0.3s' }} />
          </div>
          {/* versus the answer's shape, not the words */}
          <div className={`h-4 w-full max-w-2xl rounded ${shimmer}`} style={{ animationDelay: '0.1s' }} />
          <div className={`h-4 w-5/6 max-w-2xl rounded ${shimmer}`} style={{ animationDelay: '0.25s' }} />
          {/* results grid placeholders */}
          <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex flex-col gap-3 overflow-hidden rounded-xl border border-line bg-surface p-3 shadow-xs">
                <div className="relative h-40 w-full overflow-hidden rounded-lg bg-line/50">
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
