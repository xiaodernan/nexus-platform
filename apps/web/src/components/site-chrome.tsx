/**
 * The page chrome. Deliberately server components: they contain no state, and keeping them on the
 * server means the only client JavaScript on a first paint is the search experience itself.
 *
 * Nav links point at routes that exist today. Linking an unfinished section would be a broken
 * promise in the interface, which §155 treats as a defect rather than a TODO.
 */

import Link from 'next/link';
import { Container, Icon, cx } from '@nexus/ui';
import { IS_MOCK, TENANT } from '@/lib/env';
import { getDict, type Dict } from '@/lib/i18n';
import { cityPath, labelFor } from '@/lib/directory';

/**
 * The one place that decides whether the `/{city}` directory may be advertised. `/guides` and
 * `/collections` degrade to an honest empty state when the platform publishes no catalogue, so they
 * are always safe to link; the directory has no platform read yet (`/api/v1/seo/*` is still on the
 * service backlog), so in live mode the URL would answer an error page. Drop the mock condition
 * once those endpoints exist.
 */
function directoryLink(dict: Dict): { href: string; label: string } | null {
  if (!IS_MOCK) return null;
  return { href: cityPath(TENANT), label: labelFor(dict.seo, 'cities', TENANT) };
}

export function SiteHeader({ locale }: { locale: string }) {
  const dict = getDict(locale);
  const directory = directoryLink(dict);
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
      <Container size="shell" className="flex h-14 items-center gap-3 sm:h-16">
        <Link href="/" className="flex items-center gap-2 rounded-md text-ink-strong hover:text-accent">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-ink">
            <Icon name="layers" size={16} />
          </span>
          <span className="text-[1.0625rem] font-semibold tracking-tight">{dict.brand.name}</span>
        </Link>

        <nav aria-label={dict.brand.tagline} className="ml-2 hidden items-center gap-1 sm:flex">
          {directory ? (
            <Link
              href={directory.href}
              className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink-strong"
            >
              {directory.label}
            </Link>
          ) : null}
          <Link href="/guides" className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink-strong">
            {dict.nav.guides}
          </Link>
          <Link
            href="/collections"
            className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink-strong"
          >
            {dict.nav.collections}
          </Link>
          <Link href="/search" className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink-strong">
            {dict.nav.search}
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {IS_MOCK ? (
            <span
              title={dict.home.demoText}
              className="hidden items-center gap-1 rounded-full border border-warning/70 bg-warning-soft px-2.5 py-1 text-2xs font-medium text-warning sm:inline-flex"
            >
              <Icon name="info" size={12} />
              {dict.home.demoTitle}
            </span>
          ) : null}
          <Link
            href="/search"
            className={cx(
              'inline-flex h-9 items-center gap-1.5 rounded-full bg-accent px-3.5 text-sm font-medium text-accent-ink shadow-xs',
              'hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
            )}
          >
            <Icon name="ai" size={14} />
            {dict.nav.search}
          </Link>
        </div>
      </Container>
    </header>
  );
}

export function SiteFooter({ locale }: { locale: string }) {
  const dict: Dict = getDict(locale);
  const directory = directoryLink(dict);
  const links = [
    ...(directory ? [directory] : []),
    { href: '/guides', label: dict.nav.guides },
    { href: '/collections', label: dict.nav.collections },
    { href: '/search', label: dict.nav.search },
  ];
  return (
    <footer className="mt-16 border-t border-line bg-surface">
      <Container size="shell" className="grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-ink-strong">{dict.footer.exploreTitle}</span>
          <ul className="flex flex-col gap-1.5">
            {links.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="text-xs text-ink-muted hover:text-accent hover:underline">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-ink-strong">{dict.footer.demoTitle}</span>
          <p className="max-w-sm text-xs leading-relaxed text-ink-muted">{dict.footer.demoText}</p>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-ink-strong">{dict.footer.methodTitle}</span>
          <p className="max-w-sm text-xs leading-relaxed text-ink-muted">{dict.footer.methodText}</p>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-ink-strong">{dict.footer.trustTitle}</span>
          <p className="max-w-sm text-xs leading-relaxed text-ink-muted">{dict.footer.trustText}</p>
        </div>
      </Container>
      <Container size="shell" className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-5 text-2xs text-ink-faint">
        <span>{dict.footer.rights}</span>
        <span className="inline-flex items-center gap-1.5">
          <Icon name="globe" size={12} />
          {dict.brand.tagline}
        </span>
      </Container>
    </footer>
  );
}

/**
 * The §155 honesty strip: whenever the page is served from fixtures rather than the platform/AI
 * services, the mode is stated at the top of the document, not only inside card badges.
 */
export function DataModeNotice({ locale }: { locale: string }) {
  if (!IS_MOCK) return null;
  const dict = getDict(locale);
  return (
    <div className="border-b border-warning/70 bg-warning-soft">
      <Container size="shell" className="flex flex-wrap items-center gap-2 py-2 text-xs text-warning">
        <Icon name="info" size={14} className="shrink-0" />
        <span className="font-semibold">{dict.home.demoTitle}</span>
        <span className="text-ink-muted">{dict.home.demoText}</span>
      </Container>
    </div>
  );
}
