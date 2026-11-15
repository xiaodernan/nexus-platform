import type { Metadata } from 'next';


import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { StampCollection } from '@/components/stamp-collection';


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
  const clock = dict.home.hkHub.clock;
  const hkDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

  return (
    <main className="mx-auto flex w-full max-w-shell flex-col px-4 sm:px-6 lg:px-8">
      <StampCollection
        copy={dict.home.stamp}
        entries={clock.map((entry) => ({ href: entry.href, label: entry.name, kicker: '' }))}
        currentDate={hkDate}
      />
    </main>
  );
}
