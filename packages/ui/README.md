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
when a pair falls under 4.5:1. Measured 2026-10-28 on the working tree, all ten pairs, tightest first:

| theme | pair | printed | measured |
| --- | --- | --- | --- |
| light | `--nexus-ink-faint` `#62697d` on surface `#ffffff` | 5.5:1 | 5.47:1 |
| light | `--nexus-accent-ink` `#ffffff` on accent `#2547f4` | 6.4:1 | 6.39:1 |
| light | `--nexus-ink-muted` `#525a70` on surface `#ffffff` | 6.9:1 | 6.87:1 |
| dark | `--nexus-accent-ink` `#080b14` on accent `#7b8cff` | 6.6:1 | 6.59:1 |
| light | `--nexus-ink` `#1b2030` on surface `#ffffff` | 16.2:1 | 16.21:1 |
| dark | `--nexus-ink-faint` `#8b93a8` on surface `#101320` | 6.0:1 | 6.02:1 |
| dark | `--nexus-ink-muted` `#a7afc3` on surface `#101320` | 8.4:1 | 8.42:1 |
| dark | `--nexus-ink` `#e6eaf4` on surface `#101320` | 15.4:1 | 15.35:1 |
| dark | `--nexus-ink-strong` `#f6f8fd` on surface `#101320` | 17.4:1 | 17.40:1 |
| light | `--nexus-ink-strong` `#0b0d14` on surface `#ffffff` | 19.4:1 | 19.41:1 |

A printed claim is measured against the ONE ground its comment names -- which is why the same reader
walks a second population. Every body-text token (`ink-strong`, `ink`, `ink-muted`, `ink-faint`,
`neutral-chip-ink`) is recomputed against every neutral ground the palette offers (`surface`,
`surface-raised`, `canvas`, `surface-muted`, `surface-sunken`, `neutral-chip`): 5 x 6 x 2 themes = 60
cells, each of which must clear 4.5:1. A component picks its own pair from two tokens and a source
reader cannot see which pair it composed, so the palette has to hold for every pair it allows.

That matrix is not decoration either. It was added because the printed table said `--nexus-ink-faint`
was 4.8:1 while the live visual test measured the home page's text at **4.477:1**: the claim was true
on `#ffffff` and the token was 4.48:1 on the `canvas` the page actually paints, 4.36:1 on
`surface-muted`, 4.21:1 on `surface-sunken` and 4.17:1 on `neutral-chip`. The token is now `#62697d`,
whose tightest cell is 4.75:1, and the matrix is what keeps the next such pair from shipping silently.

The tightest cell in the palette is the light theme's `--nexus-ink-faint` at 4.75:1 on `neutral-chip`,
which clears AA body text by 0.25. That is the number to move first if a token changes.

**What this table cannot see.** It is a source measurement, not a browser's computed style: a colour
inherited from a parent, a background image behind the text, or a pair involving a colour that is not a
palette token is outside it. Tinted grounds (`accent-soft`, `positive-soft`, `warning-soft`,
`danger-soft`) are outside it too -- those pair with their own semantic ink, and a census that guessed
which token a component meant to put there would be inventing its population. What it now does cover is
every palette token on every neutral ground, which is the composition the home page was failing.
