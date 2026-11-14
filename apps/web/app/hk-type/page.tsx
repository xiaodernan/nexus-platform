import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Icon } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { HkQuiz } from '@/components/hk-quiz';

export const dynamic = 'force-static';

/**
 * `/hk-type` — the 互動篇章 of the Hong Kong story series: an 8-question archetype quiz
 * mapped to the three chapters this product ships. Interactive, entirely client-side, no
 * telemetry, zero API calls — the same honesty rules the rest of the product plays by,
 * one step closer to "Hong Kong in your pocket".
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.hkType.title,
    description: dict.hkType.intro,
    alternates: { canonical: '/hk-type' },
  };
}

export default async function HkTypePage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const chapters = dict.hkType.chapters;

  return (
    <div className="relative overflow-hidden border-b border-line bg-surface">
      <div aria-hidden="true" className="nexus-dot-grid pointer-events-none absolute inset-0" />
      <Container size="shell" className="relative flex flex-col items-center gap-8 py-14 text-center sm:py-20">
        <nav aria-label={dict.nav.guides} className="flex flex-wrap items-center justify-center gap-2">
          {chapters.map((chapter) => (
            <Link
              key={chapter.href}
              href={chapter.href}
              className="group inline-flex items-center gap-2 rounded-full border border-accent-line bg-accent-soft px-4 py-2 text-sm text-accent shadow-xs transition-colors hover:border-accent hover:bg-accent-soft hover:shadow-sm"
            >
              <Icon name="quote" size={13} className="text-accent" />
              <span className="font-semibold">{chapter.title}</span>
              <span className="text-2xs uppercase tracking-wide text-ink-faint">{chapter.hint}</span>
            </Link>
          ))}
        </nav>
        <HkQuiz locale={locale} />
      </Container>
    </div>
  );
}
