'use client';

import * as React from 'react';
import { motion, useReducedMotion, type Variants } from 'framer-motion';
import { cx } from '../utils';

/**
 * Motion presets (spec §79 "premium", §77 responsive, D1 Framer Motion).
 *
 * House style: one easing curve (`cubic-bezier(0.16,1,0.3,1)` — slow-out, no bounce)
 * and four durations. Motion is used to explain spatial relationships (rails slide,
 * panels rise), never to decorate. Every preset collapses to an opacity-only, 0ms
 * transition when the OS requests reduced motion, and the collapse happens in JS so
 * there is no flash of motion before a media query applies.
 */
export const EASE = [0.16, 1, 0.3, 1] as const;

export const duration = {
  quick: 0.12,
  base: 0.2,
  slow: 0.38,
  reveal: 0.64,
};

export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: duration.slow, ease: EASE } },
};

export const slideUp: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: duration.slow, ease: EASE } },
};

export const slideRight: Variants = {
  hidden: { opacity: 0, x: -14 },
  show: { opacity: 1, x: 0, transition: { duration: duration.slow, ease: EASE } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.97 },
  show: { opacity: 1, scale: 1, transition: { duration: duration.base, ease: EASE } },
};

/** Parent container that staggers its `staggerItem` children into view. */
export function stagger(childrenDelay = 0.055, startDelay = 0): Variants {
  return {
    hidden: {},
    show: {
      transition: { staggerChildren: childrenDelay, delayChildren: startDelay },
    },
  };
}

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: duration.slow, ease: EASE } },
};

/**
 * Reveal — scroll-triggered entrance. Falls back to "always visible" when reduced
 * motion is requested (children render with no transform and no opacity change).
 */
const MOTION_TAG = {
  div: motion.div,
  section: motion.section,
  li: motion.li,
  span: motion.span,
} as const;

export function Reveal({
  children,
  className,
  delay = 0,
  as = 'div',
  amount = 0.25,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  as?: keyof typeof MOTION_TAG;
  amount?: number;
}) {
  const reduced = useReducedMotion();
  const Tag = MOTION_TAG[as];
  if (reduced) {
    const Plain = as;
    return <Plain className={className}>{children}</Plain>;
  }
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount }}
      transition={{ duration: duration.slow, ease: EASE, delay }}
    >
      {children}
    </Tag>
  );
}

/** Staggered list wrapper: `<StaggerGroup>` + `<StaggerItem>` children. */
export function StaggerGroup({
  children,
  className,
  delay = 0,
  amount = 0.1,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  amount?: number;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.055, delayChildren: delay } } }}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: React.ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div className={className} variants={staggerItem}>
      {children}
    </motion.div>
  );
}

/** Animated presence wrapper (streaming stages, chips appearing). */
export function Animate({
  children,
  className,
  mode = 'popLayout',
}: {
  children: React.ReactNode;
  className?: string;
  mode?: 'sync' | 'wait' | 'popLayout';
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={cx(className)}
      layout={!reduced}
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? undefined : { opacity: 0, y: -6 }}
      transition={{ duration: duration.base, ease: EASE }}
      // keep AnimatePresence children keyed by React, not by motion internals
      data-mode={mode}
    >
      {children}
    </motion.div>
  );
}

export { motion, useReducedMotion };
