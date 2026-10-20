# @nexus/ui

The design system (§78): `src/styles/tokens.css` (the token layer), `src/primitives/` (the controls),
`src/feedback/` and `src/trust/` (the renderers that carry the product's honesty rules), and
`tailwind-preset.ts`, which `apps/web/tailwind.config.ts` spreads so a page-level config only adds content
globs. Components are consumed through npm workspaces plus Next's `transpilePackages`.

## The token contract

Components name colours semantically (`bg-surface`, `text-ink-muted`, `border-line`); raw `gray-*` /
`blue-*` utilities are not part of the system, and a hex value in a component is a bug. Dark mode is a
`class` flip on `<html>`, never a second stylesheet, which is why the tokens are CSS custom properties
rather than build-time constants.

A token that a component applies an `/NN` alpha modifier to needs a channel-triplet sibling
(`--nexus-accent-rgb: 37 71 244`), because Tailwind composes `rgb(var(--x) / <alpha-value>)` only from
space-separated channels -- with a bare hex variable it drops the whole utility, silently, at build time.
`apps/web/src/lib/tokens.test.ts` asserts that every `-rgb` sibling matches its hex.

## Contrast (WCAG 2.1 AA)

`src/styles/tokens.css` prints a ratio beside every piece of text it colours. Those numbers are
measurements, not decoration, and something reads them:

```
node scripts/check_console_a11y.mjs --verbose
```

recomputes each printed pair from the hex values in the same file -- WCAG 2.1 relative luminance, sRGB
gamma -- and fails when a printed ratio is not the measurement (to the one decimal the comment prints) or
when a pair falls under 4.5:1. Measured 2026-09-29 on the working tree, all ten pairs, tightest first:

| theme | pair | printed | measured |
| --- | --- | --- | --- |
| light | `--nexus-ink-faint` `#6a7288` on surface `#ffffff` | 4.8:1 | 4.80:1 |
| light | `--nexus-accent-ink` `#ffffff` on accent `#2547f4` | 6.4:1 | 6.39:1 |
| light | `--nexus-ink-muted` `#525a70` on surface `#ffffff` | 6.9:1 | 6.87:1 |
| dark | `--nexus-accent-ink` `#080b14` on accent `#7b8cff` | 6.6:1 | 6.59:1 |
| light | `--nexus-ink` `#1b2030` on surface `#ffffff` | 16.2:1 | 16.21:1 |
| dark | `--nexus-ink-faint` `#8b93a8` on surface `#101320` | 6.0:1 | 6.02:1 |
| dark | `--nexus-ink-muted` `#a7afc3` on surface `#101320` | 8.4:1 | 8.42:1 |
| dark | `--nexus-ink` `#e6eaf4` on surface `#101320` | 15.4:1 | 15.35:1 |
| dark | `--nexus-ink-strong` `#f6f8fd` on surface `#101320` | 17.4:1 | 17.40:1 |
| light | `--nexus-ink-strong` `#0b0d14` on surface `#ffffff` | 19.4:1 | 19.41:1 |

The tightest pair in the palette is the light theme's `--nexus-ink-faint` at 4.80:1, which clears AA body
text by 0.30. That is the number to move first if a token changes.

**What this table cannot see.** It is a source measurement, not a browser's computed style: a pair
assembled from two classNames on two elements, a colour inherited from a parent, or a background image
behind the text is outside it. It also covers the ten pairs `tokens.css` prints a ratio for, not every
combination a page can compose. A pair that is not printed here has not been measured by anything.
