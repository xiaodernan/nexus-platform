import preset from '@nexus/ui/tailwind-preset';

/**
 * apps/web Tailwind config — deliberately thin: the entire token system lives in
 * `@nexus/ui/tailwind-preset` so the merchant/admin route groups cannot diverge (§78).
 * Content globs cover both this app and the workspace source of `@nexus/ui`.
 */
export default {
  presets: [preset],
  content: [
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
    '../../packages/ui/tailwind-preset.ts',
  ],
  plugins: [],
};
