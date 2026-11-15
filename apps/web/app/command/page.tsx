import type { Metadata } from 'next';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { CommandConsoleClient } from '@/components/command-console';


export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.cmdConsole.title,
    description: dict.cmdConsole.intro,
    alternates: { canonical: '/command' },
    robots: { index: false, follow: false },
  };
}

export default async function CommandConsolePage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  return (
    <main>
      <CommandConsoleClient copy={dict.cmdConsole} />
    </main>
  );
}
