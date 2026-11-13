import { Container } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * Loading boundary for `/o/[slug]` (ƒ) — an offering's full detail (facts lines, price tag,
 * availability) is fetched in one publication read, so cold navigations on this route paint
 * blank. This boundary renders the prose column shape only. Decorative layers
 * `aria-hidden="true"`; `dict.states.loading` is the only copy. Motion-reduce collapses
 * every shimmer bar to `animate-none`.
 */
export default async function OfferingLoading() {
  const locale = await currentLocale();
  const dict = getDict(locale);

  const shimmer = 'bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none';

  return (
    <>
      <span role="status" className="sr-only">{dict.states.loading}</span>

      <section aria-hidden="true" className="py-6 sm:py-10">
        <Container size="prose" className="flex flex-col gap-5">
          {/* offering title block + provider attribution */}
          <div className="flex flex-col gap-3">
            <div className={`h-9 w-full rounded ${shimmer}`} />
            <div className={`h-9 w-3/5 rounded ${shimmer}`} style={{ animationDelay: '0.15s' }} />
            <div className={`h-4 w-48 rounded ${shimmer}`} style={{ animationDelay: '0.3s' }} />
          </div>
          {/* price / facts lines */}
          <div className="flex flex-wrap items-center gap-3">
            <div className={`h-8 w-32 rounded-full ${shimmer}`} style={{ animationDelay: '0.1s' }} />
            <div className={`h-6 w-36 rounded ${shimmer}`} style={{ animationDelay: '0.2s' }} />
            <div className={`h-6 w-28 rounded ${shimmer}`} style={{ animationDelay: '0.3s' }} />
          </div>
          {/* description lines */}
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className={`h-4 ${i % 3 === 2 ? 'w-4/5' : 'w-full'} rounded ${shimmer}`} style={{ animationDelay: `${0.05 + i * 0.08}s` }} />
            ))}
          </div>
        </Container>
      </section>
    </>
  );
}
