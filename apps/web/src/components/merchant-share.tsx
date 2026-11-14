'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Icon, cx } from '@nexus/ui';

/**
 * The share affordance on the merchant profile.
 *
 * Hong Kong conversation runs on WhatsApp and WeChat; a consumer who wants to send a friend
 * "this place, for Saturday" reaches for the thumb, not the keyboard. So the affordance is a
 * single glyph at the same height as the directions and call buttons, and the payload behind
 * it is exactly the two things that work everywhere: a copyable link whose source is the page
 * it lives on, and a WhatsApp draft carrying the merchant name plus that link.
 *
 * Constraints kept deliberate:
 *  - No analytics — the click is a tap, not a tracked event.
 *  - No provider URLs beyond wa.me (which needs no key and no service permission).
 *  - No link shortener — the canonical /m/{slug} is the one URL that must never be stripped.
 *  - No extra fonts or tokens; it wears the same chrome the two neighbours do.
 */
export interface ShareLabels {
  share: string;
  shareTitle: string;
  copy: string;
  copyFailed: string;
  waLabel: string;
  copied: string;
}

export function MerchantShare({
  slug,
  name,
  labels,
  className,
}: {
  slug: string;
  name: string;
  labels: ShareLabels;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const shareUrl = typeof window === 'undefined' ? `https://local/m/${slug}` : window.location.href;

  // Close on Escape and on any outside pointer — the popover dismisses itself without teleporting.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setFailed(true);
      setCopied(false);
    }
  }, []);

  const whatsappHref = `https://wa.me/?text=${encodeURIComponent(`${name} — ${shareUrl}`)}`;

  return (
    <div
      ref={containerRef}
      className={cx('relative inline-flex', className)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={titleId}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3.5 py-2 text-sm text-ink-strong shadow-xs transition-colors hover:border-accent hover:text-accent"
      >
        <Icon name="share" size={14} />
        {labels.share}
      </button>

      {open ? (
        <div
          id={titleId}
          role="dialog"
          aria-label={labels.shareTitle}
          className="absolute right-0 top-full z-40 mt-2 w-64 rounded-lg border border-line bg-surface p-3 text-sm shadow-md"
        >
          <p className="mb-2 truncate text-2xs text-ink-faint" title={name}>{name}</p>
          <p className="truncate rounded-md bg-surface-muted px-2 py-1.5 font-mono text-2xs text-ink-muted" title={shareUrl}>{shareUrl}</p>
          <div className="mt-2 flex flex-col gap-1.5">
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-strong hover:border-accent hover:text-accent"
            >
              <Icon name="link" size={12} />
              {copied ? labels.copied : labels.copy}
            </button>
            <a
              href={whatsappHref}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-md bg-positive-soft px-2.5 py-1.5 text-xs text-positive hover:brightness-95"
            >
              <Icon name="phone" size={12} />
              {labels.waLabel}
            </a>
            {failed ? <p className="text-2xs text-warning">{labels.copyFailed}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
