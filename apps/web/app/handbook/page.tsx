import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Icon, Badge } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

/**
 * `/handbook` — the product's own instruction booklet, in HK Traditional at one door and
 * English at the other. A complete, still brief tour: the SearchBox, the rails, the HK series +
 * three daily instruments, the `/hk-type` game tutorial, /me, the merchant shell, the honesty
 * contract — plus a five-step new-user walkthrough up front.
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.handbook.title,
    description: dict.handbook.intro,
    alternates: { canonical: '/handbook' },
  };
}

export default async function HandbookPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.handbook;

  const quickLinks = dict.handbook.quickLinks;

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-line bg-surface">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(64rem 38rem at 88% -18%, rgb(var(--nexus-accent-rgb) / 0.14), transparent 65%), ' +
              'radial-gradient(46rem 30rem at -12% 28%, rgb(var(--nexus-accent-rgb) / 0.09), transparent 60%)',
          }}
        />
        <div aria-hidden="true" className="nexus-dot-grid pointer-events-none absolute inset-0" />
        <Container size="shell" className="relative flex flex-col gap-6 py-12 sm:py-16">
          <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.eyebrow}</span>
          <h1 className="max-w-[26ch] text-4xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-5xl">
            {copy.title}
          </h1>
          <p className="max-w-prose text-base leading-relaxed text-ink-muted">{copy.intro}</p>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <Link
              href="/search"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover"
            >
              {copy.cta}
              <Icon name="arrowRight" size={14} />
            </Link>
            <ul className="flex flex-wrap gap-2">
              {quickLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-line bg-surface px-3.5 py-2 text-sm text-ink-muted shadow-xs transition-colors hover:border-accent hover:text-accent"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Container>
      </section>

      <Container size="shell" className="py-10 sm:py-12">
        {/* The first try — a real query, not a slogan */}
        <section aria-labelledby="handbook-example" className="relative overflow-hidden rounded-2xl border border-accent-line bg-accent-soft p-6">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-10 -top-14 h-40 w-40 rounded-full"
            style={{ background: 'var(--nexus-ai-gradient)', opacity: 0.16, filter: 'blur(36px)' }}
          />
          <div className="relative flex flex-col gap-3">
            <span id="handbook-example" className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">
              {copy.exampleLabel}
            </span>
            <p className="max-w-prose rounded-lg border border-line bg-surface px-4 py-3 font-mono text-sm leading-snug text-ink-strong">
              {copy.exampleQuery}
            </p>
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{copy.exampleCaption}</p>
          </div>
        </section>

        {/* Five-step walk-through */}
        <section aria-labelledby="handbook-tour" className="mt-10 flex flex-col gap-4">
          <h2 id="handbook-tour" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">
            {copy.tourTitle}
          </h2>
          <ol className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {copy.tour.map((step, index) => (
              <li key={index} className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
                <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-2xs font-semibold text-accent">
                  {index + 1}
                </span>
                <span className="text-sm font-semibold leading-snug text-ink-strong">{step.title}</span>
                <span className="text-2xs leading-relaxed text-ink-muted">{step.text}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* Two-column: jump rail + full content (below lg the rail stacks; min-w-0 keeps the
            grid track from inflating past the viewport on small screens) */}
        <section aria-label={copy.navTitle} className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <nav aria-label={copy.navTitle} className="min-w-0 lg:sticky lg:top-6 lg:self-start">
            <div className="flex w-full min-w-0 flex-col gap-2 rounded-xl border border-line bg-canvas p-4">
              <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-ink-muted">{copy.navTitle}</span>
              <ul className="flex min-w-0 flex-col gap-1">
                {copy.sections.map((section) => (
                  <li key={section.id} className="min-w-0">
                    <a href={`#${section.id}`} className="block break-words rounded-md px-2 py-1.5 text-xs text-ink-muted transition-colors hover:bg-surface hover:text-accent">
                      {section.title.split('·')[0]?.trim() ?? section.title} — {section.kicker}
                    </a>
                  </li>
                ))}
              </ul>
              <Link
                href="/hk-type"
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-accent-line bg-accent-soft px-2 py-1.5 text-2xs font-medium text-accent transition-colors hover:border-accent"
              >
                {dict.nav.hkType}
                <Icon name="arrowRight" size={12} />
              </Link>
            </div>
          </nav>

          <div className="flex min-w-0 flex-col gap-6">
            {copy.sections.map((section, index) => (
              <article
                key={section.id}
                id={section.id}
                className="scroll-mt-24 rounded-xl border border-line bg-surface p-6"
              >
                <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
                  <div className="flex items-center gap-2">
                    <Badge tone="accent" size="sm">{section.kicker}</Badge>
                    <span aria-hidden="true" className="text-2xs font-mono text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                  </div>
                  <Icon name="layers" size={14} className="text-ink-faint" />
                </div>
                <h2 className="mt-4 text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">
                  {section.title}
                </h2>
                <div className="mt-3 flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-ink-muted">
                  {section.paragraphs.map((paragraph, i) => (
                    <p key={i}>{paragraph}</p>
                  ))}
                </div>
                {section.bullets && section.bullets.length > 0 ? (
                  <ul className="mt-4 grid gap-2">
                    {section.bullets.map((bullet, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-ink-strong">
                        <Icon name="check" size={14} className="mt-0.5 shrink-0 text-accent" />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {section.id === 'stategraph' && copy.stategraphDiagram ? (
                  <figure className="mt-6 max-w-prose rounded-xl border border-accent-line bg-canvas p-5">
                    <figcaption className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">
                      {copy.stategraphDiagram.title}
                    </figcaption>
                    <svg viewBox="0 0 620 236" role="img" aria-label={copy.stategraphDiagram.title} className="mt-3 w-full text-ink-strong">
                      <text x="0" y="22" fontSize="10" fontWeight="700" letterSpacing="0.2em" fill="currentColor">
                        {copy.stategraphDiagram.graphLabel}
                      </text>
                      <rect x="0" y="34" width="124" height="48" rx="10" fill="rgb(var(--nexus-accent-rgb) / 0.12)" stroke="rgb(var(--nexus-accent-rgb) / 0.55)" strokeWidth="1" />
                      <text x="62" y="63" fontSize="12" fontWeight="600" textAnchor="middle" fill="currentColor">make_plan</text>
                      <path d="M124 58 L156 58" stroke="currentColor" strokeWidth="1.6" fill="none" />
                      <path d="M154 54 L161 58 L154 62" stroke="currentColor" strokeWidth="1.6" fill="none" />
                      <rect x="164" y="34" width="96" height="48" rx="10" fill="rgb(var(--nexus-accent-rgb) / 0.12)" stroke="rgb(var(--nexus-accent-rgb) / 0.55)" strokeWidth="1" />
                      <text x="212" y="63" fontSize="12" fontWeight="600" textAnchor="middle" fill="currentColor">route</text>
                      <path d="M260 58 L292 58" stroke="currentColor" strokeWidth="1.6" fill="none" />
                      <path d="M290 54 L297 58 L290 62" stroke="currentColor" strokeWidth="1.6" fill="none" />
                      <text x="276" y="48" fontSize="8" textAnchor="middle" fill="currentColor" opacity="0.8">ok</text>
                      <rect x="300" y="34" width="104" height="48" rx="10" fill="rgb(var(--nexus-accent-rgb) / 0.2)" stroke="rgb(var(--nexus-accent-rgb) / 0.8)" strokeWidth="1.4" strokeDasharray="4 3" />
                      <text x="352" y="63" fontSize="12" fontWeight="700" textAnchor="middle" fill="currentColor">fanout</text>
                      <path d="M404 58 L436 58" stroke="currentColor" strokeWidth="1.6" fill="none" />
                      <path d="M434 54 L441 58 L434 62" stroke="currentColor" strokeWidth="1.6" fill="none" />
                      <rect x="444" y="34" width="104" height="48" rx="10" fill="rgb(var(--nexus-accent-rgb) / 0.12)" stroke="rgb(var(--nexus-accent-rgb) / 0.55)" strokeWidth="1" />
                      <text x="496" y="63" fontSize="12" fontWeight="600" textAnchor="middle" fill="currentColor">emit</text>
                      <path d="M212 82 C212 128 168 142 124 142" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" fill="none" opacity="0.65" />
                      <path d="M124 142 L148 142 L148 210 L212 210" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" fill="none" opacity="0.65" />
                      <text x="210" y="118" fontSize="8" textAnchor="end" fill="currentColor" opacity="0.75">refused →</text>
                      <text x="0" y="152" fontSize="10" fontWeight="700" letterSpacing="0.2em" fill="currentColor">
                        {copy.stategraphDiagram.serialLabel}
                      </text>
                      <rect x="0" y="162" width="124" height="44" rx="10" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" />
                      <text x="62" y="189" fontSize="12" fontWeight="600" textAnchor="middle" fill="currentColor">make_plan</text>
                      <path d="M124 184 L188 184" stroke="currentColor" strokeWidth="1.6" fill="none" opacity="0.65" />
                      <path d="M186 180 L193 184 L186 188" stroke="currentColor" strokeWidth="1.6" fill="none" opacity="0.65" />
                      <rect x="200" y="162" width="126" height="44" rx="10" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" />
                      <text x="263" y="189" fontSize="11" fontWeight="600" textAnchor="middle" fill="currentColor">serial loop</text>
                      <path d="M326 184 L500 184 L496 189" stroke="currentColor" strokeWidth="1.6" fill="none" opacity="0.65" />
                      <path d="M500 182 L510 184 L500 186" stroke="currentColor" strokeWidth="1.6" fill="none" opacity="0.65" />
                      <rect x="514" y="162" width="104" height="44" rx="10" fill="rgb(var(--nexus-accent-rgb) / 0.12)" stroke="rgb(var(--nexus-accent-rgb) / 0.55)" strokeWidth="1" />
                      <text x="566" y="189" fontSize="12" fontWeight="600" textAnchor="middle" fill="currentColor">emit</text>
                    </svg>
                    <p className="mt-3 text-2xs leading-relaxed text-ink-muted">{copy.stategraphDiagram.caption}</p>
                    <p className="mt-2 font-mono text-[11px] text-ink-faint">{copy.stategraphDiagram.defaultNote}</p>
                    <Link
                      href="/stategraph"
                      className="mt-4 inline-flex h-9 items-center gap-2 rounded-full border border-accent-line bg-accent-soft px-4 text-2xs font-medium text-accent transition-colors hover:border-accent"
                    >
                      {copy.stategraphDiagram.runbookCta}
                      <Icon name="arrowRight" size={12} aria-hidden="true" />
                    </Link>
                  </figure>
                ) : null}
              </article>
            ))}
          </div>
        </section>

        <p className="mt-8 max-w-prose text-2xs leading-relaxed text-ink-faint">{copy.screenshotNote}</p>
      </Container>
    </div>
  );
}
