import { Container } from '@nexus/ui';

/**
 * `/me` streaming placeholder: the identity panel shimmer, then the two profile sheets.
 * Mirrors the eventual layout so the swap doesn't shift the fold.
 */
export default function Loading() {
  return (
    <Container size="wide" className="pb-24 pt-8 sm:pt-10" aria-busy="true">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-surface">
        <div className="relative grid gap-6 p-6 sm:p-8 lg:grid-cols-[1.6fr_1fr] lg:gap-10">
          <div className="flex flex-col gap-4">
            <div className="h-3 w-24 animate-pulse rounded-full bg-surface-muted" />
            <div className="flex items-center gap-4">
              <div className="h-16 w-16 animate-pulse rounded-2xl bg-surface-muted" />
              <div className="flex flex-col gap-2">
                <div className="h-6 w-48 animate-pulse rounded-md bg-surface-muted" />
                <div className="h-3 w-40 animate-pulse rounded-full bg-surface-muted" />
              </div>
            </div>
            <div className="h-4 w-64 animate-pulse rounded-full bg-surface-muted" />
          </div>
          <div className="flex items-stretch gap-0 self-center lg:self-end lg:justify-end">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex min-w-[5.5rem] flex-col items-center gap-2 border-l border-line px-4 py-2 first:border-l-0 sm:min-w-[7rem] sm:px-6">
                <div className="h-4 w-4 animate-pulse rounded-md bg-surface-muted" />
                <div className="h-6 w-8 animate-pulse rounded-md bg-surface-muted" />
                <div className="h-3 w-12 animate-pulse rounded-full bg-surface-muted" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-8 grid gap-8 xl:grid-cols-[1.7fr_1fr]">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            <div className="h-5 w-40 animate-pulse rounded-md bg-surface-muted" />
            <div className="h-3 w-56 animate-pulse rounded-full bg-surface-muted" />
            <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-2">
              {[0, 1].map((index) => (
                <div key={index} className="h-48 animate-pulse rounded-2xl border border-line bg-surface" />
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-6">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-48 animate-pulse rounded-2xl border border-line bg-surface"
            />
          ))}
        </div>
      </div>
    </Container>
  );
}
