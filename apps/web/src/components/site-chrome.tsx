/**
 * The page chrome. Deliberately server components: they contain no state, and keeping them on the
 * server means the only client JavaScript on a first paint is the search experience itself — and,
 * since D713, the theme switch (`ThemeToggle`), which is the one control that cannot exist without
 * a click handler. It is an island in a server tree: the rest of the chrome stays on the server,
 * and the theme it controls is applied by the inline script in `app/layout.tsx` before the first
 * paint, so the island's arrival changes nothing that was already on screen.
 *
 * Nav links point at routes that exist today. Linking an unfinished section would be a broken
 * promise in the interface, which §155 treats as a defect rather than a TODO.
 */

import Link from 'next/link';
import { Container, Icon, cx } from '@nexus/ui';
import { IS_MOCK, TENANT } from '@/lib/env';
import { getDict, type Dict } from '@/lib/i18n';
import { cityPath, labelFor } from '@/lib/directory';
import { ThemeToggle } from './theme-toggle';
import { LocaleToggle } from './locale-toggle';

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
          <Link
            href="/guides"
            title={dict.nav.hints.guides}
            className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink-strong"
          >
            {dict.nav.guides}
          </Link>
          <Link
            href="/collections"
            title={dict.nav.hints.collections}
            className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink-strong"
          >
            {dict.nav.collections}
          </Link>
          <Link
            href="/search"
            title={dict.nav.hints.search}
            className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink-strong"
          >
            {dict.nav.search}
          </Link>
          <Link
            href="/handbook"
            title={dict.nav.hints.handbook}
            className="rounded-full px-3 py-1.5 text-sm font-medium text-ink-strong hover:bg-accent hover:text-accent-ink"
            aria-label={dict.nav.newbie}
          >
            {dict.nav.newbie}
          </Link>
          <Link
            href="/me"
            title={dict.nav.hints.me}
            className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink-strong"
            aria-label={dict.nav.account}
          >
            {dict.nav.account}
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/handbook"
            aria-label={dict.nav.newbie}
            title={dict.nav.hints.handbook}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-line text-ink-muted transition-colors hover:border-accent hover:text-accent sm:hidden"
          >
            <Icon name="info" size={18} />
          </Link>
          {IS_MOCK ? (
            <span
              title={dict.home.demoText}
              className="hidden items-center gap-1 rounded-full border border-warning/70 bg-warning-soft px-2.5 py-1 text-2xs font-medium text-warning sm:inline-flex"
            >
              <Icon name="info" size={12} />
              {dict.home.demoTitle}
            </span>
          ) : null}
          <LocaleToggle
            locale={locale}
            labels={{
              toEn: '切換到英文版 — 整頁一鍵互換中英文',
              toZh: 'Switch to the Traditional Chinese edition — one click swaps the whole page',
            }}
          />
          <ThemeToggle labels={{ toDark: dict.nav.themeToDark, toLight: dict.nav.themeToLight }} />
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
    { href: '/try', label: locale === 'zh-HK' ? '新手試試' : 'Quick try', title: locale === 'zh-HK' ? '五步直通 · 一分鐘試用產品' : 'Five steps · one minute to feel the product' },
    { href: '/guides', label: dict.nav.guides, title: dict.nav.hints.guides },
    { href: '/collections', label: dict.nav.collections, title: dict.nav.hints.collections },
    { href: '/search', label: dict.nav.search, title: dict.nav.hints.search },
    { href: '/me', label: dict.nav.account, title: dict.nav.hints.me },
    { href: '/hk-type', label: dict.nav.hkType, title: dict.nav.hints.hkType },
    { href: '/handbook', label: dict.nav.handbook, title: dict.nav.hints.handbook },
    { href: '/daily', label: dict.nav.daily, title: dict.nav.hints.daily },
    { href: '/stamp', label: locale === 'zh-HK' ? '印章收集' : 'Passport stamps', title: locale === 'zh-HK' ? '已讀章節集印 — 每讀一章，護照就多一個章印' : 'Every read chapter earns a stamp — 50 stamps to a complete passport' },
    { href: '/command', label: locale === 'zh-HK' ? '指揮台' : 'Command desk', title: locale === 'zh-HK' ? '管理員 demo 頁 — 輸入 123 解鎖，看兩個星期的合成數據' : 'Demo operator view — unlock with 123 to read the synthetic two-week ledger' },
    { href: '/insights', label: locale === 'zh-HK' ? '營運掃描' : 'Operator scan', title: locale === 'zh-HK' ? '虛擬讀者的每日鬼影分析 — 一頁看完，不存數據' : 'Daily ghost-readers from a deterministic replay — one screen, zero stored data' },
    { href: '/stategraph', label: locale === 'zh-HK' ? '引擎讀本' : 'The engine', title: locale === 'zh-HK' ? '一張圖講清楚智能代理怎麼走 — make_plan → route → fanout → emit' : 'One graph, four nodes: make_plan → route → fanout → emit' },
    { href: '/llm-ops', label: locale === 'zh-HK' ? '模型手術枱' : 'LLM ops', title: locale === 'zh-HK' ? '大模型怎麼在產品裡流轉 — envelope A/B · prefix cache · router · weekly probe（真機實測）' : 'How the model actually moves through the product — envelope A/B · prefix cache · router · weekly probe (live-measured)' },
    { href: '/chronicle', label: locale === 'zh-HK' ? '系列全書' : 'The Chronicle', title: locale === 'zh-HK' ? '一座城的一天 — 一百零五章、三幕、一段史詩的全書錨位' : 'One city, one day — the 105-chapter, three-act codex of this arc' },
    { href: '/afterward', label: locale === 'zh-HK' ? '收工之後' : 'The Afterward', title: locale === 'zh-HK' ? '第二十四版全書的尾巴——零點到天亮之間的五個守夜瞬間' : 'The tail of the closed day — five flashes between midnight and dawn' },
    { href: '/world', label: locale === 'zh-HK' ? '世界地圖' : 'World atlas', title: locale === 'zh-HK' ? '全景地圖 — 全系列 105 章按時辰攤開，七層一次讀完' : 'The whole series — 105 chapters, seven layers, one read' },
    { href: '/hong-kong', label: dict.home.hkHub.seriesLink, title: dict.nav.hints.hongKong },
  ];
  return (
    <footer className="mt-16 border-t border-line bg-surface">
      <Container size="shell" className="grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-ink-strong">{dict.footer.exploreTitle}</span>
          <ul className="flex flex-col gap-1.5">
            {links.map((link) => (
              <li key={link.href}>
                <Link href={link.href} title={'title' in link ? link.title : undefined} className="text-xs text-ink-muted hover:text-accent hover:underline">
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
      <Container size="shell" className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-5 text-2xs text-ink-faint">
        <span>{dict.footer.rights}</span>
        <span className="inline-flex items-center gap-2.5">
          <Icon name="globe" size={12} />
          <span className="text-xs text-ink-faint">{dict.brand.tagline}</span>
          <span aria-hidden="true" className="text-ink-faint">·</span>
          <span
            aria-hidden="true"
            className="text-sm font-semibold tracking-tight"
            style={{
              background: 'var(--nexus-ai-gradient)',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              color: 'transparent',
            }}
          >
            {dict.brand.name}
          </span>
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
    <div data-nexus-demo-notice="mock" className="border-b border-warning/70 bg-warning-soft">
      <Container size="shell" className="flex flex-wrap items-center gap-2 py-2 text-xs text-warning">
        <Icon name="info" size={14} className="shrink-0" />
        <span className="font-semibold">{dict.home.demoTitle}</span>
        <span className="text-ink-muted">{dict.home.demoText}</span>
      </Container>
    </div>
  );
}
