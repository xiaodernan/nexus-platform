'use client';

import { Icon } from '@nexus/ui';

import { LOCALE_COOKIE } from '@/lib/i18n';

/**
 * The one-click zh-HK ↔ en switch: writes the `nexus_locale` cookie the server-side i18n layer
 * reads (`src/lib/i18n/server.ts`) and reloads the page so the whole document — header, body
 * copy, footer, metadata — is re-resolved in the other locale. The cookie is the truth; nothing
 * in the client bundle carries both dictionaries.
 */
export function LocaleToggle({ locale, labels }: { locale: string; labels: { toEn: string; toZh: string } }) {
  const isZh = locale === 'zh-HK';
  const nextLocale = isZh ? 'en' : 'zh-HK';
  const ariaLabel = isZh ? labels.toEn : labels.toZh;

  const toggle = () => {
    document.cookie = `${LOCALE_COOKIE}=${nextLocale}; path=/; max-age=31536000; samesite=lax`;
    window.location.reload();
  };

  return (
    <button
      type="button"
      onClick={toggle}
      data-nexus-locale-toggle=""
      aria-label={ariaLabel}
      title={ariaLabel}
      className="inline-flex h-9 items-center justify-center gap-1 rounded-full border border-line px-2.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Icon name="globe" size={13} />
      {isZh ? 'EN' : '中'}
    </button>
  );
}
