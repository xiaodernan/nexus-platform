import { Container } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * D1028 — the first paint of `/` streams as a brand-anchored skeleton instead of a blank
 * server wait. The page renders its rails only after every rail fetch settles (allSettled by
 * design), which can take a full upstream round trip on a cold visit; a shimmer scaffold stops
 * the blank white flash without claiming anything the data plane has not answered yet.
 *
 * Copy discipline (§155, D981): the only text rendered here comes from the dictionaries — the
 * eyebrow label and the sr-only loading caption (`dict.states.loading`, zh 加載中… / en Loading…).
 * Everything else is a shape, not a claim. `aria-hidden` keeps the shimmer bars off the
 * accessibility tree; the sr-only caption announces the state. Motion-reduce collapses every
 * shimmer bar to `animate-none`.
 */
export default async function HomeLoading() {
  const locale = await currentLocale();
  const dict = getDict(locale);

  const shimmerBar = (w: string, h: string, delay = '0s') => (
    <div
      className={`${h} ${w} rounded-md bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none`}
      style={{ animationDelay: delay }}
    />
  );

  return (
    <>
      <span role="status" className="sr-only">{dict.states.loading}</span>

      <section aria-hidden="true" className="relative overflow-hidden border-b border-line bg-surface">
        {/* Same corner glows as the real hero, at the same palette, so the skeleton does not pop against the page. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(64rem 38rem at 88% -18%, rgb(var(--nexus-accent-rgb) / 0.14), transparent 65%), ' +
              'radial-gradient(46rem 30rem at -12% 28%, rgb(var(--nexus-accent-rgb) / 0.09), transparent 60%)',
          }}
        />
        <Container size="shell" className="relative flex flex-col gap-7 py-14 sm:py-20">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full shadow-xs ring-1 ring-inset ring-black/10"
                  style={{ background: 'var(--nexus-ai-gradient)' }} />
            <span className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">{dict.home.eyebrow}</span>
          </span>

          <div className="flex max-w-[26ch] flex-col gap-3">
            {shimmerBar('w-full', 'h-10 sm:h-12')}
            {shimmerBar('w-4/5', 'h-10 sm:h-12', '0.15s')}
          </div>
          <div className="max-w-prose flex-col gap-2 flex">
            {shimmerBar('w-full', 'h-4', '0.25s')}
            {shimmerBar('w-2/3', 'h-4', '0.4s')}
          </div>
        </Container>
      </section>

      <section aria-hidden="true" className="py-10">
        <Container size="shell" className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="h-6 w-36 rounded-md bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none" />
            <div className="h-6 w-64 rounded-md bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none" style={{ animationDelay: '0.2s' }} />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex flex-col gap-3 overflow-hidden rounded-xl border border-line bg-surface p-3 shadow-xs">
                <div className="relative h-40 w-full overflow-hidden rounded-lg bg-line/50">
                  <div className="absolute inset-y-0 left-0 w-1/3 bg-ink/5 [animation:nexus-shimmer_1.4s_ease-in-out_infinite] motion-reduce:animate-none" style={{ animationDelay: `${i * 0.12}s` }} />
                </div>
                <div className="h-4 w-3/4 rounded bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none" />
                <div className="h-3 w-1/2 rounded bg-line/60 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none" style={{ animationDelay: '0.2s' }} />
                <div className="h-3 w-2/3 rounded bg-line/50 [animation:nexus-shimmer_1.15s_ease-in-out_infinite] motion-reduce:animate-none" style={{ animationDelay: '0.35s' }} />
              </div>
            ))}
          </div>
        </Container>
      </section>
    </>
  );
}
