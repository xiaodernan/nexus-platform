'use client';

import * as React from 'react';
import { cx } from '../utils';

/** Deterministic pastel-free tint from a string so avatars never need an image fetch. */
function hueFrom(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/**
 * Avatar — initials fallback, optional image. Renders a CSS-generated tint when no
 * `src` is given (the offline-safe default for demo data), so we never hotlink photos.
 */
export function Avatar({
  name,
  src,
  size = 36,
  className,
  alt,
}: {
  name: string;
  src?: string | null;
  size?: 24 | 28 | 32 | 36 | 44 | 56;
  className?: string;
  alt?: string;
}) {
  const initials = React.useMemo(
    () =>
      name
        .split(/[\s·-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join(''),
    [name],
  );
  const hue = hueFrom(name);
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.36)),
        background: src ? undefined : `linear-gradient(150deg, hsl(${hue} 62% 92%), hsl(${(hue + 40) % 360} 58% 84%))`,
        color: src ? undefined : `hsl(${hue} 60% 26%)`,
      }}
      role="img"
      aria-label={alt ?? name}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        initials || <span aria-hidden>·</span>
      )}
    </span>
  );
}
