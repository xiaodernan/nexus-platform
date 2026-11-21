import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Icon } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { GuidedPlayCoach } from '@/components/guided-play-coach';


export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.home.tryFlow.title,
    description: dict.home.tryFlow.intro,
    alternates: { canonical: '/try' },
  };
}

export default async function TryFlowPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const flow = dict.home.tryFlow;
  const numeral = ['1', '2', '3', '4', '5'];

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-line bg-canvas">
        <div aria-hidden="true" className="nexus-dot-grid pointer-events-none absolute inset-0" />
        <div aria-hidden="true" className="nexus-horizon pointer-events-none" />
        <Container size="shell" className="relative flex flex-col gap-6 py-12 sm:py-16">
          <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{flow.eyebrow}</span>
          <h1 className="max-w-[24ch] text-4xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-5xl">
            {flow.title}
          </h1>
          <p className="max-w-prose text-base leading-relaxed text-ink-muted">{flow.intro}</p>
        </Container>
      </section>

      {/* Five steps, one scroll */}
      <Container size="shell" className="flex flex-col gap-10 py-10">
        <GuidedPlayCoach
          copy={dict.home.guidedPlay}
          steps={flow.steps.map((step) => ({ title: step.title, href: step.href }))}
        />
        <ol className="flex flex-col gap-6">
          {flow.steps.map((step, index) => (
            <li
              key={step.href}
              className="grid grid-cols-[auto,1fr] gap-4 sm:grid-cols-[auto,1fr,auto] sm:gap-6"
            >
              <span
                aria-hidden="true"
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-accent-line bg-accent-soft font-mono text-lg font-bold text-accent"
              >
                {numeral[index]}
              </span>
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">{step.kicker}</span>
                <h2 className="text-xl font-semibold leading-snug tracking-tight text-ink-strong sm:text-2xl">
                  {step.title}
                </h2>
                <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{step.body}</p>
                <code className="mt-1 w-fit overflow-hidden rounded-md border border-line bg-surface px-2.5 py-1 font-mono text-2xs text-accent">
                  {step.example}
                </code>
              </div>
              <Link
                href={step.href}
                className="col-span-2 inline-flex h-fit items-center gap-2 self-start rounded-full border border-accent bg-surface px-4 py-2 text-xs font-semibold text-accent transition-colors hover:bg-accent hover:text-accent-ink sm:col-span-1 sm:self-center"
              >
                {step.cta}
                <Icon name="arrowRight" size={12} />
              </Link>
            </li>
          ))}
        </ol>

        {/* Closing call-to-action */}
        <section className="relative mt-2 overflow-hidden rounded-2xl border border-accent-line bg-accent-soft p-6 sm:p-10">
          <div aria-hidden="true" className="pointer-events-none absolute -right-12 -top-20 h-64 w-64 rounded-full" style={{ background: 'var(--nexus-ai-gradient)', opacity: 0.22, filter: 'blur(48px)' }} />
          <div className="relative flex flex-col items-start gap-4">
            <h2 className="text-2xl font-semibold leading-tight tracking-tight text-ink-strong sm:text-3xl">
              {flow.ctaTitle}
            </h2>
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{flow.ctaBody}</p>
            <Link
              href="/search?q=open%20cha%20chaan%20teng%20tonight"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover"
            >
              {flow.cta}
              <Icon name="arrowRight" size={16} />
            </Link>
          </div>
        </section>
      </Container>
    </div>
  );
}
