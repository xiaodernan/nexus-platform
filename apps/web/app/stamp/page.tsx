import type { Metadata } from 'next';


import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { StampCollection } from '@/components/stamp-collection';
import { mockGuides } from '@/lib/mock';


export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.home.stamp.title,
    description: dict.home.stamp.intro,
    alternates: { canonical: '/stamp' },
  };
}

export default async function StampCollectionPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  // D1594: the curated clock holds 106 chips, but the copy promises a stamp per chapter.
  // Derive the tracker from the full corpus so its total is the real 188, not 106.
  const corpus = mockGuides(locale).filter((guide) => guide.slug.startsWith('hk-'));
  const hkDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

  return (
    <main className="mx-auto flex w-full max-w-shell flex-col px-4 sm:px-6 lg:px-8">
      <StampCollection
        copy={dict.home.stamp}
        entries={corpus.map((guide, index) => ({
          href: `/guides/${guide.slug}`,
          label: guide.title,
          kicker: String(index + 1),
        }))}
        currentDate={hkDate}
      />
    </main>
  );
}
