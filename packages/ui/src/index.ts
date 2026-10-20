/**
 * @nexus/ui — the NEXUS design system (§78) and the trust renderers (§19/§35).
 *
 * Consumption (apps/web): imported as a workspace package and transpiled by Next via
 * `transpilePackages: ['@nexus/ui']`, so no build step is needed for the UI package.
 * Token CSS is imported once by the root layout: `@nexus/ui/styles.css`.
 *
 * Two hard rules for contributors:
 *  1. No literal copy in this package — every user-visible string is a required prop
 *     (see `TrustLabels`), because apps/web owns localisation ([`AGENT_CONTRACT.md`](../../../../docs/AGENT_CONTRACT.md) §12).
 *  2. No raw color values — components use the semantic tokens from ./styles/tokens.css,
 *     surfaced through ./tailwind-preset.
 */

export * from './utils';
export * from './icons/Icon';

export * from './primitives/Button';
export * from './primitives/button-classes';
export * from './primitives/Input';
export * from './primitives/field-classes';
export * from './primitives/Card';
export * from './primitives/Badge';
export * from './primitives/Avatar';
export * from './primitives/Skeleton';
export * from './primitives/Layout';
export * from './primitives/Overlay';
export * from './primitives/Tabs';
export * from './primitives/Select';
export * from './primitives/Floating';

export * from './motion/Motion';

export * from './trust/types';
export * from './trust/fact';
export * from './trust/Renderers';
// The model (`EntityCard`, from ./trust/types) and the component share a name in the contract docs.
// The barrel exports the component as `EntityCardView` so `EntityCard` always means the wire type.
export { EntityCard as EntityCardView, EntityRail } from './trust/EntityCard';
export type { EntityCardProps } from './trust/EntityCard';
export * from './trust/CompareTable';

export * from './feedback/States';
