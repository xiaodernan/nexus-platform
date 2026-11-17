import type { Metadata } from 'next';

import { Container } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { HkDailyAlmanac } from '@/components/hk-daily-almanac';
import { HkCantoneseDaily } from '@/components/hk-cantonese-daily';
import { HkDailyDate } from '@/components/hk-daily-date';
import { HkDailyArcPick } from '@/components/hk-daily-arc-pick';
import { HkDailyShare } from '@/components/hk-daily-share';
import { AhWanDialogue } from '@/components/ah-wan-dialogue';

/**
 * `/daily` — the daily ritual page. Three pillars in one place: 今日食運 (the deterministic daily
 * almanac), 每日一句廣東話 (a hand-checked phrase with Jyutping and an English gloss) and 今日讀章
 * (a deterministic chapter suggestion from the HK series). Everyone on the same page on the same
 * day reads the same chapter and speaks the same phrase — a shared city rhythm, not a feed.
 *
 * Server-rendered shell, client islands for the two live pieces (date, clipboard) and for the two
 * already-existing daily islands. No backend, no fetch, no telemetry.
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.home.daily.title,
    description: dict.home.daily.intro,
    alternates: { canonical: '/daily' },
  };
}

export default async function DailyPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.home.daily;
  const cantonese = dict.home.hkHub?.cantonese ?? null;
  const dailyAlmanac = dict.home.hkDaily;

  return (
    <div className="flex flex-col">
      {/* Hero: one monumental line, one quiet pillar row */}
      <section className="relative overflow-hidden border-b border-line bg-surface">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(64rem 36rem at 88% -18%, rgb(var(--nexus-accent-rgb) / 0.16), transparent 65%), ' +
              'radial-gradient(48rem 30rem at -12% 28%, rgb(var(--nexus-accent-rgb) / 0.1), transparent 60%)',
          }}
        />
        <div aria-hidden="true" className="nexus-dot-grid pointer-events-none absolute inset-0" />
        <Container size="shell" className="relative flex flex-col gap-6 py-14 sm:py-20">
          <HkDailyDate weekdays={copy.weeks} separator={copy.dateSeparator} />
          <span className="text-2xs font-semibold uppercase tracking-[0.3em] text-accent">{copy.eyebrow}</span>
          <h1 className="max-w-[18ch] text-5xl font-semibold leading-[1.02] tracking-tight text-ink-strong sm:text-7xl">
            {copy.title}
          </h1>
          <p className="max-w-prose text-base leading-relaxed text-ink-muted sm:text-lg">{copy.intro}</p>
          <div
            aria-hidden="true"
            className="h-px w-24 bg-accent/60"
          />
        </Container>
      </section>

      {/* The live NPC — one tower, one voice, mounted on the daily ritual page only. */}
      <section aria-label={dict.home.npcAhWan.title} className="border-b border-line bg-surface">
        <Container size="shell" className="flex py-10">
          <AhWanDialogue locale={locale} labels={dict.home.npcAhWan} />
        </Container>
      </section>

      {/* Pillars: the three instruments, each keeping its own discipline */}
      <section aria-label={copy.eyebrow} className="border-b border-line bg-canvas">
        <Container size="shell" className="grid gap-6 py-8 lg:grid-cols-2">
          <div className="flex flex-col gap-6">
            <HkDailyAlmanac daily={dailyAlmanac} />
            {cantonese ? <HkCantoneseDaily copy={cantonese} /> : null}
          </div>
          <div className="flex flex-col gap-6">
            <HkDailyArcPick cards={dict.home.hkSeries.cards} dict={copy.arcPick} />
            <HkDailyShare
              almanacEntries={dailyAlmanac.entries}
              phraseEntries={cantonese?.pool ?? []}
              cards={dict.home.hkSeries.cards}
              dict={copy.share}
            />
          </div>
        </Container>
      </section>
    </div>
  );
}
