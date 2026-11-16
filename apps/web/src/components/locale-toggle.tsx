'use client';

import { Icon } from '@nexus/ui';

import { LOCALE_COOKIE } from '@/lib/i18n';

/**
 * Three-state locale cycle: zh-HK → zh-CN → en → zh-HK.
 *
 * Clicking always advances to the NEXT locale in the cycle; the cookie remains the truth
 * the server reads (`src/lib/i18n/server.ts`), so every head/body/footer/metadata re-resolves
 * in the next locale. The value is one of `zh-HK`, `zh-CN`, or `en` — the dict contract
 * carries exactly those three (see `LOCALES` in `dict.ts`).
 *
 *   < LocaleToggle locale={locale} labels={{
 *       toHk: 'Switch to Traditional Chinese — one click',
 *       toCn: 'Switch to Simplified Chinese — one click',
 *       toEn: 'Switch to English — one click',
 *   }} />
 */
export function LocaleToggle({
  locale,
  labels,
}: {
  locale: string;
  labels: { toHk: string; toCn: string; toEn: string };
}) {
  const order = ['zh-HK', 'zh-CN', 'en'] as const;
  const idx = Math.max(0, order.indexOf(locale as (typeof order)[number]));
  const nextLocale = order[(idx + 1) % order.length]!;
  const ariaLabel = nextLocale === 'zh-HK' ? labels.toHk : nextLocale === 'zh-CN' ? labels.toCn : labels.toEn;
  const glyph = nextLocale === 'zh-HK' ? '港' : nextLocale === 'zh-CN' ? '简' : 'EN';

  const cycle = () => {
    document.cookie = `${LOCALE_COOKIE}=${nextLocale}; path=/; max-age=31536000; samesite=lax`;
    window.location.reload();
  };

  return (
    <button
      type="button"
      onClick={cycle}
      data-nexus-locale-toggle=""
      aria-label={ariaLabel}
      title={ariaLabel}
      className="inline-flex h-9 items-center justify-center gap-1 rounded-full border border-line px-2.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Icon name="globe" size={13} />
      {glyph}
    </button>
  );
}
