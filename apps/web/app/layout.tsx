import type { Metadata, Viewport } from 'next';

import '@nexus/ui/styles.css';
import './globals.css';

import { SITE_URL } from '@/lib/env';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme';
import { DataModeNotice, SiteFooter, SiteHeader } from '@/components/site-chrome';
import { ScrollProgress } from '@/components/scroll-progress';

/**
 * The single document shell. Everything user-visible about the *app* — locale, the demo-data
 * strip, the skip link, the footer disclosures — is decided once, here, so no page can quietly
 * drop the §155 notice or the §78 rhythm.
 *
 * There is deliberately **no `app/loading.tsx`**. That file would create a Suspense boundary at the
 * root segment, which makes Next flush the document shell (and therefore commit `HTTP 200`) before
 * a dynamic page segment has resolved; a page that then calls `notFound()` would render the 404 body
 * under a 200 status — the soft 404 §29 forbids publishing. Measured on this build: with the file
 * present `/m/does-not-exist` answers 200, without it 404. A route that genuinely needs a skeleton
 * must carry its own `<Suspense>` *inside* the segment, below the point where `notFound()` is decided.
 */

export async function generateMetadata(): Promise<Metadata> {
  // The shell's own copy is localised too: a static `metadata` block here would hand a zh-HK
  // `<title>` to every page that does not override it, including the 404.
  const dict = getDict(await currentLocale());
  return {
    metadataBase: new URL(SITE_URL),
    title: {
      default: `${dict.brand.name} — ${dict.brand.tagline}`,
      template: `%s · ${dict.brand.name}`,
    },
    description: dict.home.subtitle,
    applicationName: dict.brand.name,
    alternates: { canonical: '/' },
    robots: { index: true, follow: true },
  };
}

export const viewport: Viewport = {
  themeColor: '#2547f4',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await currentLocale();
  const dict = getDict(locale);

  return (
    <html lang={dict.htmlLang}>
      <head>
        {/* The stored theme, applied before the first paint. The token sheet promises no FOUC flash
            ("the inline script in app/layout.tsx applies the stored theme before paint"), and a
            component could not keep that promise — it would arrive with the page already painted. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-canvas text-ink antialiased">
        <a href="#nexus-main" className="nexus-sr-only">
          {dict.nav.skipToContent}
        </a>
        <ScrollProgress />
        <SiteHeader locale={locale} />
        <DataModeNotice locale={locale} />
        <main id="nexus-main">{children}</main>
        <SiteFooter locale={locale} />
      </body>
    </html>
  );
}
