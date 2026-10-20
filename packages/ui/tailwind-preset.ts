/**
 * NEXUS Tailwind preset — the JS half of the token contract.
 * `apps/web/tailwind.config.ts` spreads this preset, so page-level config only adds
 * content globs. Colors resolve to the CSS variables in ./src/styles/tokens.css,
 * which means dark mode is a `class` flip and never a second stylesheet.
 *
 * Naming contract: use semantic names (`bg-surface`, `text-ink-muted`, `border-line`)
 * in components. Raw `gray-*` / `blue-*` utilities are not part of the system.
 */
const fontStack =
  'var(--nexus-font-sans), ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** @type {import('tailwindcss').Config} */
export const nexusPreset = {
  darkMode: ['class'],
  theme: {
    extend: {
      colors: {
        /* Tokens carrying an `-rgb` sibling are exposed through rgb(<triplet> / <alpha-value>) so
           `/NN` modifiers compile; see tokens.css for why a bare hex var cannot. The sibling must
           match the hex — apps/web/src/lib/tokens.test.ts asserts it in CI. */
        accent: {
          DEFAULT: 'rgb(var(--nexus-accent-rgb) / <alpha-value>)',
          hover: 'var(--nexus-accent-hover)',
          active: 'var(--nexus-accent-active)',
          ink: 'var(--nexus-accent-ink)',
          soft: 'rgb(var(--nexus-accent-soft-rgb) / <alpha-value>)',
          'soft-ink': 'var(--nexus-accent-soft-ink)',
          line: 'rgb(var(--nexus-accent-line-rgb) / <alpha-value>)',
        },
        ai: 'var(--nexus-ai-ink)',
        canvas: 'var(--nexus-canvas)',
        surface: {
          DEFAULT: 'rgb(var(--nexus-surface-rgb) / <alpha-value>)',
          raised: 'var(--nexus-surface-raised)',
          sunken: 'var(--nexus-surface-sunken)',
          muted: 'rgb(var(--nexus-surface-muted-rgb) / <alpha-value>)',
          overlay: 'var(--nexus-surface-overlay)',
          inverse: 'var(--nexus-surface-inverse)',
        },
        ink: {
          /* `text-ink-strong` is the name every component uses; the CSS variable is
             --nexus-ink-strong. An earlier `strongest` key matched neither, so 28 call
             sites compiled to no utility at all. */
          strong: 'rgb(var(--nexus-ink-strong-rgb) / <alpha-value>)',
          DEFAULT: 'var(--nexus-ink)',
          muted: 'var(--nexus-ink-muted)',
          faint: 'var(--nexus-ink-faint)',
          disabled: 'var(--nexus-ink-disabled)',
          inverse: 'var(--nexus-ink-inverse)',
        },
        line: {
          DEFAULT: 'var(--nexus-border)',
          strong: 'var(--nexus-border-strong)',
          inverse: 'var(--nexus-border-inverse)',
        },
        positive: { DEFAULT: 'rgb(var(--nexus-positive-rgb) / <alpha-value>)', soft: 'rgb(var(--nexus-positive-soft-rgb) / <alpha-value>)' },
        warning: { DEFAULT: 'rgb(var(--nexus-warning-rgb) / <alpha-value>)', soft: 'rgb(var(--nexus-warning-soft-rgb) / <alpha-value>)' },
        danger: { DEFAULT: 'rgb(var(--nexus-danger-rgb) / <alpha-value>)', soft: 'rgb(var(--nexus-danger-soft-rgb) / <alpha-value>)' },
        chip: { DEFAULT: 'var(--nexus-neutral-chip)', ink: 'var(--nexus-neutral-chip-ink)' },
      },
      fontFamily: {
        sans: [fontStack],
        mono: ['var(--nexus-font-mono)', 'ui-monospace', 'monospace'],
      },
      /* Modular scale tuned for mixed CJK + Latin. Display sizes carry negative
         tracking; body sizes stay at 0 so Chinese glyphs do not collide. */
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.02em' }],
        xs: ['0.75rem', { lineHeight: '1.1rem' }],
        sm: ['0.875rem', { lineHeight: '1.35rem' }],
        base: ['1rem', { lineHeight: '1.65rem' }],
        lg: ['1.125rem', { lineHeight: '1.75rem' }],
        xl: ['1.3125rem', { lineHeight: '1.85rem', letterSpacing: '-0.01em' }],
        '2xl': ['1.625rem', { lineHeight: '2.1rem', letterSpacing: '-0.016em' }],
        '3xl': ['2rem', { lineHeight: '2.4rem', letterSpacing: '-0.022em' }],
        '4xl': ['2.625rem', { lineHeight: '2.9rem', letterSpacing: '-0.028em' }],
        '5xl': ['3.375rem', { lineHeight: '3.6rem', letterSpacing: '-0.032em' }],
        '6xl': ['4.25rem', { lineHeight: '4.3rem', letterSpacing: '-0.036em' }],
      },
      borderRadius: {
        xs: 'var(--nexus-radius-xs)',
        sm: 'var(--nexus-radius-sm)',
        md: 'var(--nexus-radius-md)',
        lg: 'var(--nexus-radius-lg)',
        xl: 'var(--nexus-radius-xl)',
        '2xl': 'var(--nexus-radius-2xl)',
      },
      boxShadow: {
        xs: 'var(--nexus-shadow-xs)',
        sm: 'var(--nexus-shadow-sm)',
        md: 'var(--nexus-shadow-md)',
        lg: 'var(--nexus-shadow-lg)',
        xl: 'var(--nexus-shadow-xl)',
        focus: 'var(--nexus-shadow-focus)',
      },
      transitionTimingFunction: {
        nexusOut: 'var(--nexus-ease-out)',
        nexusInOut: 'var(--nexus-ease-in-out)',
        nexusSpring: 'var(--nexus-ease-spring)',
      },
      transitionDuration: {
        quick: '120ms',
        base: '200ms',
        slow: '380ms',
        reveal: '640ms',
      },
      /* Mobile-first containers; `shell` is the reading width for search results. */
      maxWidth: {
        shell: '72rem',
        prose: '46rem',
      },
      keyframes: {
        'nexus-fade-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'nexus-pulse': {
          '0%,100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        'fade-up': 'nexus-fade-up 480ms cubic-bezier(0.16,1,0.3,1) both',
        'nexus-pulse': 'nexus-pulse 1600ms ease-in-out infinite',
      },
    },
  },
};

export default nexusPreset;
