import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { guideBySlug, guideList } from '@/lib/data';
import { SITE_URL } from '@/lib/env';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { Container } from '@nexus/ui';
import { GuideView } from '@/components/growth-view';
import { JsonLd } from '@/components/json-ld';
import { ChapterAskLive } from '@/components/chapter-ask-live';
import { WorldGuideBeacon } from '@/components/world-guide-beacon';
import { ChapterRadar } from '@/components/chapter-radar';
import { TicketArcRail } from '@/components/ticket-arc-rail';
import { ticketArcFor, TICKET_ARC_SLUGS } from '@/lib/ticket-arc';
import { crossingArcFor, CROSSING_ARC_SLUGS } from '@/lib/crossing-arc';
import { timetableArcFor, TIMETABLE_ARC_SLUGS } from '@/lib/timetable-arc';

/**
 * `/guides/{slug}` (§8, §28). An unreviewed AI guide is still readable, but it is kept out of the
 * index: publishing machine-written prose at scale is the §30 failure, so a human check is what turns
 * it into an indexed document. The page itself always shows the review state and the disclosure.
 */

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata(props: Props): Promise<Metadata | undefined> {
  const { slug } = await props.params;
  const locale = await currentLocale();
  const guide = (await guideBySlug(decodeURIComponent(slug), locale)).data;
  if (!guide) return undefined;
  return {
    title: guide.title,
    description: guide.description,
    alternates: { canonical: `/guides/${guide.slug}` },
    robots: guide.reviewed_by_human ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: {
      title: guide.title,
      description: guide.description,
      url: `${SITE_URL}/guides/${guide.slug}`,
      type: 'article',
    },
  };
}

export default async function GuidePage(props: Props) {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const { slug } = await props.params;
  const guide = (await guideBySlug(decodeURIComponent(slug), locale)).data;
  if (!guide) notFound();
  // D1530: the radar reads the SAME corpus the index serves, so it works on both planes.
  const corpus = (await guideList(locale)).data.items;

  return (
    <>
      <GuideView guide={guide} locale={locale} />
      <Container size="shell" className="-mt-4 pb-10 sm:pb-14">
        {/* D1284 — the chapter's live companion; fail-closed, and inert in mock mode. */}
        <ChapterAskLive
          chapterSlug={guide.slug}
          locale={locale}
          labels={dict.growth.chapterAsk}
        />
        {/* D1530 — the chapter radar: this chapter's neighbours, computed on this machine. */}
        <ChapterRadar guides={corpus} slug={guide.slug} copy={dict.growth.chapterRadar} />
        {/* D1563 + D1567 — the curated arcs: the ticket arc and the crossing arc. Curated, local,
            server-rendered; each rail renders on its own five chapters and nowhere else. */}
        {(() => {
          const ticket = ticketArcFor(guide.slug);
          const crossing = crossingArcFor(guide.slug);
          const timetable = timetableArcFor(guide.slug);
          const arc = ticket ?? crossing ?? timetable;
          if (!arc) return null;
          const slugs = ticket ? TICKET_ARC_SLUGS : crossing ? CROSSING_ARC_SLUGS : TIMETABLE_ARC_SLUGS;
          const titles = slugs.map((s) => corpus.find((g) => g.slug === s)?.title ?? s);
          const copy = ticket ? dict.growth.ticketArc : crossing ? dict.growth.crossingArc : dict.growth.timetableArc;
          return <TicketArcRail position={arc} titles={titles} copy={copy} />;
        })()}
        {/* D1306 — the live world guide; one compass button, one next step. */}
        <WorldGuideBeacon
          chapterSlug={guide.slug}
          locale={locale}
          surface="chapter"
          minutes={45}
          labels={dict.growth.worldGuide}
        />
      </Container>
      <JsonLd
        value={{
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: guide.title,
          description: guide.description,
          datePublished: guide.published_at,
          dateModified: guide.updated_at,
          inLanguage: dict.locale,
          // The author field says who wrote it, and only what the payload actually knows: a model is
          // credited as a model, and a guide with no named human author gets no `author` at all.
          ...(guide.generated_by === 'ai'
            ? { author: { '@type': 'Organization', name: `${dict.brand.name} AI` } }
            : {}),
          publisher: { '@type': 'Organization', name: dict.brand.name, url: SITE_URL },
          mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE_URL}/guides/${guide.slug}` },
        }}
      />
    </>
  );
}
