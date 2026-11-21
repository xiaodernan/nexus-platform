import type { Metadata } from 'next';
import Link from 'next/link';

import { currentLocale } from '@/lib/i18n/server';
import { getDict, type Dict } from '@/lib/i18n';
import { mockGuides } from '@/lib/mock';
import { Container } from '@nexus/ui';
import { StoryRecap } from '@/components/story-recap';
import { WayfinderPanel } from '@/components/wayfinder-panel';
import { WorldAnswerPanel } from '@/components/world-answer-panel';

/**
 * `/world` — the atlas page. A single-scroll dossier of the entire HK-series corpus,
 * partitioned by hour into the seven layers the day actually moves through. Nothing on
 * this page is invented outside the dictionary or the arc clock; nothing is duplicated by
 * hand — the 106 hour chips are read straight from `dict.home.hkHub.clock`, and the full
 * corpus section reads every guide from the seed at render time, so the atlas can never
 * drift behind the series it describes. Bilingual in the same breath; SSR per
 * request; no client island (this is a dossier, not a feed).
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await currentLocale();
  const dict = getDict(locale);
  return {
    title: dict.world.title,
    description: dict.world.intro,
    alternates: { canonical: '/world' },
    robots: { index: true, follow: true },
  };
}

type Chip = Dict['home']['hkHub']['clock'][number];

const LAYER_BOUNDARIES = [225, 465, 720, 1020, 1140, 1290]; // 03:45 07:45 12:00 17:00 19:00 21:30

const minutes = (time: string): number => {
  const [h, m] = time.split(':').map((n) => Number(n));
  return (h ?? 0) * 60 + (m ?? 0);
};

const layerOf = (time: string): number => {
  const m = minutes(time);
  let i = 0;
  while (i < LAYER_BOUNDARIES.length && m >= (LAYER_BOUNDARIES[i] ?? 9999)) i += 1;
  return i;
};

export default async function WorldPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const t = dict.world;
  const clock: Chip[] = dict.home.hkHub.clock;
  // The whole HK-series corpus, straight from the seed in the reader's language — the
  // count and every link are derived, so a new chapter appears here the moment it lands.
  // The two non-series guides (rainy-day / date-plan) are not numbered chapters.
  const corpus = mockGuides(locale).filter((guide) => guide.slug.startsWith('hk-'));

  const byLayer: Chip[][] = t.layers.map(() => []);
  for (const chip of clock) {
    const idx = layerOf(chip.time);
    if (idx >= 0 && idx < byLayer.length) {
      (byLayer[idx] as Chip[]).push(chip);
    }
  }

  return (
    <div className="flex flex-col">
      <section className="relative overflow-hidden border-b border-line bg-surface">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(64rem 40rem at 88% -20%, rgb(var(--nexus-accent-rgb) / 0.16), transparent 66%), ' +
              'radial-gradient(52rem 34rem at -14% 32%, rgb(var(--nexus-accent-rgb) / 0.11), transparent 62%)',
          }}
        />
        <Container size="shell" className="relative py-12 sm:py-16">
          <span className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.24em] text-accent">
            {t.eyebrow}
          </span>
          <h1 className="mt-3 max-w-[22ch] text-4xl font-semibold leading-[1.1] tracking-tight text-ink-strong sm:text-5xl">
            {t.title}
          </h1>
          <p className="mt-4 max-w-prose leading-relaxed text-ink-muted">{t.intro}</p>
          <p className="mt-4 text-2xs leading-relaxed text-ink-faint">{t.countNote}</p>
        </Container>
      </section>

      <Container size="shell" className="py-10">
        <StoryRecap
          locale={locale}
          copy={{
            cta: t.recapCta,
            pending: t.recapPending,
            proven: t.recapProven,
            watchLabel: t.recapWatchLabel,
          }}
        />
        <WayfinderPanel locale={locale} copy={t.wayfinder} />
        <WorldAnswerPanel locale={locale} copy={t.worldAnswer} />
        <nav aria-label={t.clockLabel} className="mb-6 flex flex-wrap items-center gap-2 border-b border-line pb-4">
          {t.layers.map((layer) => (
            <a
              key={layer.code}
              href={`#world-layer-${layer.code}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-3 py-1.5 text-2xs font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent"
            >
              <span className="font-mono text-accent">{layer.code.toUpperCase()}</span>
              <span className="hidden sm:inline">{layer.title}</span>
            </a>
          ))}
        </nav>

        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {t.layers.map((layer, idx) => {
            const chips = byLayer[idx] ?? [];
            return (
              <section
                key={layer.code}
                aria-labelledby={`world-layer-${layer.code}`}
                className="flex flex-col rounded-2xl border border-line bg-surface p-5"
              >
                <h2 id={`world-layer-${layer.code}`} className="text-lg font-semibold text-ink-strong">
                  {layer.title}
                </h2>
                <p className="mt-1 text-2xs uppercase tracking-[0.18em] text-accent">{t.clockLabel}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-muted">{layer.blurb}</p>
                <ul className="mt-4 flex flex-1 flex-wrap content-start gap-2">
                  {chips.map((chip) => (
                    <li key={chip.href}>
                      <Link
                        href={chip.href}
                        className="inline-flex items-baseline gap-2 rounded-full border border-line bg-canvas px-3 py-1.5 text-2xs text-ink transition-colors hover:border-accent hover:text-accent"
                      >
                        <span className="font-mono text-ink-strong">{chip.time}</span>
                        <span>{chip.name}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 border-t border-line pt-3 text-2xs font-mono text-ink-faint">
                  {String(chips.length).padStart(2, '0')} / {String(clock.length).padStart(2, '0')}
                </p>
              </section>
            );
          })}
        </div>

        {/* D1487 — the full corpus, beyond the curated hour-clock anchors. */}
        <section aria-labelledby="world-corpus" className="mt-10">
          <h2 id="world-corpus" className="text-lg font-semibold text-ink-strong">{t.corpusTitle}</h2>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">{t.corpusIntro}</p>
          <p className="mt-2 font-mono text-2xs text-accent">{t.corpusCount(corpus.length)}</p>
          <ol className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {corpus.map((guide, index) => (
              <li key={guide.slug}>
                <Link
                  href={`/guides/${guide.slug}`}
                  className="flex items-baseline gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-2xs text-ink transition-colors hover:border-accent hover:text-accent"
                >
                  <span className="shrink-0 font-mono text-accent">{String(index + 1).padStart(3, '0')}</span>
                  <span className="min-w-0 truncate">{guide.title}</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6 text-2xs text-ink-faint">
          <span>{t.footerNote}</span>
          <span className="flex flex-wrap items-center gap-4">
            <Link href="/hong-kong" title={t.atlasLinkHints.hongKong} className="text-accent hover:underline">/hong-kong</Link>
            <Link href="/handbook" title={t.atlasLinkHints.handbook} className="text-accent hover:underline">/handbook</Link>
            <Link href="/stamp" title={t.atlasLinkHints.stamp} className="text-accent hover:underline">/stamp</Link>
          </span>
        </footer>
      </Container>
    </div>
  );
}
