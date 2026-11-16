import type { Metadata } from 'next';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { CommandConsoleClient } from '@/components/command-console';
import { realTrace } from '@/lib/real-trace';


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
  const trace = realTrace();
  return (
    <main>
      {/* A serialisable row set — the client console paints the table; the rows themselves
          were collected server-side at build time and never touch the network. */}
      <CommandConsoleClient copy={dict.cmdConsole} traceRows={trace.rows} traceTotals={trace.totals} />
    </main>
  );
}
