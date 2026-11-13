import { Container } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * Loading boundary for `/m/[slug]` (ƒ) — the merchant detail route blocks on the full merchant
 * read (facts, hours, offerings, reviews) before its first paint. This boundary renders the
 * shape of that page so cold navigations are not blank: hero block, fact lines, two panel
 * placeholders. Decorative layers `aria-hidden="true"`; `dict.states.loading` is the only
 * copy. Motion-reduce collapses every shimmer bar to `animate-none`.
 */
export default async function MerchantLoading() {
  const locale = await currentLocale();
  const dict = getDict(locale);

  const shimmer = 'bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none';

  return (
    <>
      <span role="status" className="sr-only">{dict.states.loading}</span>

      <section aria-hidden="true" className="py-6 sm:py-10">
        <Container size="shell" className="flex flex-col gap-6">
          {/* hero block: name row + address lines + fact badges */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="h-16 w-16 rounded-2xl bg-line/60 [animation:nexus-shimmer_1.4s_ease-in-out_infinite] motion-reduce:animate-none" />
              <div className="flex flex-col gap-2">
                <div className={`h-8 w-64 rounded ${shimmer}`} />
                <div className={`h-4 w-40 rounded ${shimmer}`} style={{ animationDelay: '0.15s' }} />
              </div>
              <div className="ml-auto flex gap-2">
                <div className={`h-7 w-24 rounded-full ${shimmer}`} style={{ animationDelay: '0.25s' }} />
                <div className={`h-7 w-24 rounded-full ${shimmer}`} style={{ animationDelay: '0.35s' }} />
              </div>
            </div>
            {/* fact strip: rating / distance / opening / price */}
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="h-4 w-4 rounded-sm bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none" style={{ animationDelay: `${i * 0.08}s` }} />
                  <span className="h-4 w-20 rounded bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none" style={{ animationDelay: `${i * 0.12 + 0.1}s` }} />
                </div>
              ))}
            </div>
          </div>

          {/* two panel placeholders, facts-like rows */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            {[0, 1].map((panel) => (
              <div key={panel} className={`flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs ${panel === 0 ? 'lg:col-span-3' : 'lg:col-span-2'}`}>
                <div className={`h-5 w-40 rounded ${shimmer}`} style={{ animationDelay: `${panel * 0.1}s` }} />
                {[0, 1, 2, 3, 4].map((row) => (
                  <div key={row} className="flex items-center justify-between gap-4">
                    <span className={`h-4 w-1/3 rounded ${shimmer}`} style={{ animationDelay: `${0.05 + row * 0.07 + panel * 0.1}s` }} />
                    <span className={`h-4 w-1/4 rounded ${shimmer}`} style={{ animationDelay: `${0.12 + row * 0.07 + panel * 0.1}s` }} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Container>
      </section>
    </>
  );
}
