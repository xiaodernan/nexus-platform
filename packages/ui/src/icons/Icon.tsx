import * as React from 'react';
import { cx } from '../utils';

/**
 * NEXUS icon set — hand-drawn inline SVG paths (no icon font, no runtime fetch,
 * no third-party glyph licence). 24x24 grid, 1.6 stroke, round caps, `currentColor`
 * so icons inherit text color and keep contrast in both themes.
 *
 * `aria-hidden` by default: icons are decorative next to a label. When an icon is the
 * only content of a control, pass `label` to emit a proper accessible name instead.
 */
export type IconName =
  | 'search'
  | 'ai'
  | 'arrowRight'
  | 'arrowLeft'
  | 'arrowUpRight'
  | 'chevronDown'
  | 'chevronUp'
  | 'chevronLeft'
  | 'chevronRight'
  | 'close'
  | 'check'
  | 'plus'
  | 'minus'
  | 'pin'
  | 'navigation'
  | 'clock'
  | 'star'
  | 'heart'
  | 'bookmark'
  | 'share'
  | 'compare'
  | 'layers'
  | 'map'
  | 'list'
  | 'grid'
  | 'filter'
  | 'user'
  | 'users'
  | 'settings'
  | 'bell'
  | 'calendar'
  | 'ticket'
  | 'wallet'
  | 'store'
  | 'globe'
  | 'mail'
  | 'lock'
  | 'sun'
  | 'moon'
  | 'menu'
  | 'info'
  | 'warning'
  | 'shield'
  | 'quote'
  | 'trending'
  | 'refresh'
  | 'download'
  | 'trash'
  | 'eye'
  | 'link'
  | 'phone'
  | 'spinner'
  | 'slash';

const PATHS: Record<IconName, React.ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  ai: (
    <>
      <path d="M12 3.5 13.7 8 18 9.6 13.7 11.2 12 15.7 10.3 11.2 6 9.6 10.3 8Z" />
      <path d="M17.5 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9Z" />
    </>
  ),
  arrowRight: <path d="M4.5 12h14m-5.5-5.5L18.5 12 13 17.5" />,
  arrowLeft: <path d="M19.5 12h-14m5.5-5.5L5.5 12 11 17.5" />,
  arrowUpRight: <path d="M7 17 17 7m0 0h-7m7 0v7" />,
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  chevronUp: <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />,
  chevronLeft: <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />,
  chevronRight: <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  pin: (
    <>
      <path d="M12 21s6.5-6.2 6.5-11a6.5 6.5 0 1 0-13 0C5.5 14.8 12 21 12 21Z" />
      <circle cx="12" cy="10" r="2.4" />
    </>
  ),
  navigation: <path d="M20 4 4 10.8l6.6 2.6L13.2 20 20 4Z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 2" />
    </>
  ),
  star: (
    <path d="m12 3.8 2.6 5.5 6 .9-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 10.2l6-.9Z" />
  ),
  heart: (
    <path d="M12 20s-7.5-4.6-7.5-9.5A4.3 4.3 0 0 1 12 8a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20Z" />
  ),
  bookmark: <path d="M6.5 4.5h11V20l-5.5-3.8L6.5 20Z" />,
  share: (
    <>
      <circle cx="17.5" cy="6" r="2.6" />
      <circle cx="6.5" cy="12" r="2.6" />
      <circle cx="17.5" cy="18" r="2.6" />
      <path d="m8.9 10.8 6.2-3.4M8.9 13.2l6.2 3.4" />
    </>
  ),
  compare: <path d="M4.5 4.5v15M12 4.5v15M19.5 4.5v15" />,
  layers: <path d="m12 3.8 8 4.2-8 4.2-8-4.2Zm8 8.6-8 4.2-8-4.2m16 4.4-8 4.2-8-4.2" />,
  map: (
    <>
      <path d="M9 4.5 3.5 6.8v12.7L9 17.2l6 2.3 5.5-2.3V4.5L15 6.8Z" />
      <path d="M9 4.5v12.7M15 6.8v12.7" />
    </>
  ),
  list: <path d="M4.5 7h15M4.5 12h15M4.5 17h9" />,
  grid: (
    <>
      <rect x="4.5" y="4.5" width="6.5" height="6.5" rx="1.6" />
      <rect x="13" y="4.5" width="6.5" height="6.5" rx="1.6" />
      <rect x="4.5" y="13" width="6.5" height="6.5" rx="1.6" />
      <rect x="13" y="13" width="6.5" height="6.5" rx="1.6" />
    </>
  ),
  filter: <path d="M4.5 6.5h15m-12 5.5h9m-6.5 5.5h4" />,
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M5.5 20c.6-3.6 3.3-5.4 6.5-5.4s5.9 1.8 6.5 5.4" />
    </>
  ),
  users: (
    <>
      <circle cx="9.5" cy="8.5" r="3.2" />
      <path d="M3.8 19.5c.5-3.2 2.9-4.8 5.7-4.8s5.2 1.6 5.7 4.8M16 5.6a3 3 0 0 1 0 5.8m1.2 3.4c2 .5 3.2 1.9 3.5 4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.6l1.9 1.1M17.2 15.3l1.9 1.1M4.9 16.4l1.9-1.1M17.2 8.7l1.9-1.1" />
    </>
  ),
  bell: <path d="M12 4a5.4 5.4 0 0 0-5.4 5.4c0 3.1-1.1 4.5-1.6 5.1h14c-.5-.6-1.6-2-1.6-5.1A5.4 5.4 0 0 0 12 4Zm-2 14.5a2 2 0 0 0 4 0" />,
  calendar: (
    <>
      <rect x="4" y="6" width="16" height="14" rx="2.6" />
      <path d="M4 10.5h16M9 4.5V7m6-2.5V7" />
    </>
  ),
  ticket: (
    <>
      <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5v1.9a2 2 0 0 0 0 3.2v1.9A2.5 2.5 0 0 1 17.5 18h-11A2.5 2.5 0 0 1 4 15.4v-1.9a2 2 0 0 0 0-3.2Z" />
      <path d="M13.5 6v12" />
    </>
  ),
  wallet: (
    <>
      <rect x="3.5" y="6.5" width="17" height="12" rx="2.8" />
      <path d="M3.5 10.5h17M16 14.5h1.5" />
    </>
  ),
  store: <path d="M4 9.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19V9.5M3 9.5 5.4 4.5h13.2L21 9.5Zm5.5 11v-5.5h7V20.5" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.6 9.5h16.8M3.6 14.5h16.8M12 3.5c-2.6 2.4-4 5.4-4 8.5s1.4 6.1 4 8.5c2.6-2.4 4-5.4 4-8.5s-1.4-6.1-4-8.5Z" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="6" width="17" height="12" rx="2.6" />
      <path d="m4.5 8.5 7.5 4.6 7.5-4.6" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2.6" />
      <path d="M8.5 11V8.6a3.5 3.5 0 0 1 7 0V11" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2.2M12 18.8V21M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M3 12h2.2M18.8 12H21M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8v.4" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.2 21 19.4H3Z" />
      <path d="M12 9.5v4.6M12 16.6v.3" />
    </>
  ),
  shield: <path d="M12 3.8 5.5 6v5.4c0 4 2.8 7.2 6.5 8.8 3.7-1.6 6.5-4.8 6.5-8.8V6Zm-2.6 8.4 2.2 2.2 4-4.4" />,
  quote: <path d="M9.5 6.5C7 8 5.5 10.4 5.5 13.4c0 2.6 1.4 4.1 3.2 4.1 1.6 0 2.8-1.1 2.8-2.7 0-1.5-1.1-2.6-2.5-2.6-.3 0-.6 0-.8.1.2-1.6 1.3-3 2.8-3.9Zm8 0C15 8 13.5 10.4 13.5 13.4c0 2.6 1.4 4.1 3.2 4.1 1.6 0 2.8-1.1 2.8-2.7 0-1.5-1.1-2.6-2.5-2.6-.3 0-.6 0-.8.1.2-1.6 1.3-3 2.8-3.9Z" />,
  trending: <path d="M4 16.5 9.5 11l3.2 3.2L20 7m0 0h-4.6M20 7v4.6" />,
  refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.6-5.7M19.8 4.5v3.6h-3.6" />,
  download: <path d="M12 4v10m0 0 4-4m-4 4-4-4M4.5 18.5h15" />,
  trash: <path d="M5 7.5h14M9.5 7.5V5.4h5v2.1M6.5 7.5 7.5 20h9l1-12.5M10.5 11v5M13.5 11v5" />,
  eye: (
    <>
      <path d="M2.8 12S6 6.6 12 6.6 21.2 12 21.2 12 18 17.4 12 17.4 2.8 12 2.8 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  link: <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1 1M13.5 10.5a4 4 0 0 0-5.7 0L5.5 12.8a4 4 0 0 0 5.7 5.7l1-1" />,
  phone: <path d="M6.5 4.5h3l1.2 3.6-2 1.4a8.4 8.4 0 0 0 5.8 5.8l1.4-2 3.6 1.2v3a1.5 1.5 0 0 1-1.7 1.5C12.4 19.6 4.4 11.6 5 6.2A1.5 1.5 0 0 1 6.5 4.5Z" />,
  spinner: <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />,
  slash: <path d="M15.5 4.5 8.5 19.5" />,
};

const FILLED: Partial<Record<IconName, boolean>> = { quote: true };

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Rendered size in px (width + height). Defaults to 20 to match `sm` control height. */
  size?: number;
  /** Accessible name. Leave undefined when the icon sits next to visible text. */
  label?: string;
  /** Spin animation, used by `spinner`. */
  spin?: boolean;
}

export function Icon({ name, size = 20, label, spin, className, ...rest }: IconProps) {
  const filled = FILLED[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cx(name === 'spinner' && spin && 'animate-[nexus-spin_900ms_linear_infinite]', className)}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

/** NEXUS wordmark — geometric "aperture" glyph, drawn not imported. */
export function Wordmark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false" className={className}>
      <defs>
        <linearGradient id="nexus-wm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--nexus-accent)" />
          <stop offset="100%" stopColor="#6b4cf6" />
        </linearGradient>
      </defs>
      <path
        d="M6 25.5V6.5l20 19V6.5"
        fill="none"
        stroke="url(#nexus-wm)"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
