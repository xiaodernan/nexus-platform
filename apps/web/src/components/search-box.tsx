'use client';

/**
 * SearchBox — the natural-language entry point (§6). It is a form, not a button: Enter submits,
 * the IME composition state must not fire a submit mid-word, and the example prompts are real
 * queries rather than decoration.
 *
 * A popover shows on focus when the field is empty — the example prompts, in the same accent-dot
 * treatment as the hero row, so the empty state offers an answer instead of a blank textbox.
 * Clicking one fills the field and submits. Escape closes the popover without submitting.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button, Icon, cx, useUniqueId } from '@nexus/ui';
import { getDict } from '@/lib/i18n';
import { examplePrompts } from '@/lib/prompts';

export function SearchBox({
  locale,
  initialQuery = '',
  size = 'lg',
  label,
  placeholder,
  onSubmitQuery,
}: {
  locale: string;
  initialQuery?: string;
  size?: 'lg' | 'md';
  /** The field's accessible name. A placeholder disappears when the user types; the name must not. */
  label?: string;
  /** The follow-up box asks a different question from the first one, so its hint differs. */
  placeholder?: string;
  /** When set, the query is handed to the parent (the streaming panel) instead of navigating. */
  onSubmitQuery?: (query: string) => void;
}) {
  const dict = getDict(locale);
  const router = useRouter();
  const inputId = useUniqueId('nexus-search');
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(initialQuery);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const composing = useRef(false);
  const name = label ?? dict.home.searchLabel;
  const hint = placeholder ?? dict.home.searchPlaceholder;

  // The example list is locale-specific and finite, so it is safe to memo-render once on mount.
  const suggestions = examplePrompts(locale as 'zh-HK' | 'en');

  useEffect(() => {
    if (!suggestionsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSuggestionsOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [suggestionsOpen]);

  // Close the popover on any outside click.
  useEffect(() => {
    if (!suggestionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setSuggestionsOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [suggestionsOpen]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const query = value.trim();
    if (!query) {
      inputRef.current?.focus();
      return;
    }
    if (onSubmitQuery) onSubmitQuery(query);
    else router.push(`/search?q=${encodeURIComponent(query)}`);
  }

  function submitValue(query: string) {
    const trimmed = query.trim();
    if (!trimmed) return;
    setSuggestionsOpen(false);
    if (onSubmitQuery) onSubmitQuery(trimmed);
    else router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <form
      onSubmit={submit}
      role="search"
      {...(onSubmitQuery ? {} : { action: '/search', method: 'get' as const })}
      className={cx('relative w-full', size === 'lg' ? 'sm:gap-3' : '')}
    >
      <label className="nexus-sr-only" htmlFor={inputId}>
        {name}
      </label>
      <div
        ref={wrapperRef}
        className={cx('flex w-full items-center gap-2', size === 'lg' ? 'sm:gap-3' : '')}
      >
        <div
          className={cx(
            'flex min-w-0 flex-1 items-center gap-2 rounded-full border border-line-strong bg-surface shadow-xs',
            'focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25',
            size === 'lg' ? 'px-4 py-2.5 sm:px-5 sm:py-3.5' : 'px-3.5 py-1.5',
          )}
        >
          <Icon name="ai" size={size === 'lg' ? 20 : 16} className="shrink-0 text-ai" />
          <input
            id={inputId}
            ref={inputRef}
            value={value}
            autoComplete="off"
            maxLength={200}
            name="q"
            placeholder={hint}
            role="combobox"
            aria-expanded={suggestionsOpen && value === '' ? 'true' : 'false'}
            aria-controls={`${inputId}-suggestions`}
            onFocus={() => setSuggestionsOpen(true)}
            onChange={(event) => {
              setValue(event.target.value);
              setSuggestionsOpen(event.target.value === '');
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing)) event.preventDefault();
              else if (event.key === 'Escape') setSuggestionsOpen(false);
            }}
            className={cx(
              'min-w-0 flex-1 bg-transparent text-ink-strong outline-none placeholder:text-ink-faint',
              size === 'lg' ? 'text-base sm:text-lg' : 'text-sm',
            )}
          />
          {value ? (
            <button
              type="button"
              onClick={() => {
                setValue('');
                setSuggestionsOpen(true);
                inputRef.current?.focus();
              }}
              className="shrink-0 rounded-full p-1 text-ink-faint hover:bg-surface-muted hover:text-ink-muted"
              aria-label={dict.search.clearQuery}
            >
              <Icon name="close" size={15} />
            </button>
          ) : null}
        </div>
        <Button type="submit" size={size === 'lg' ? 'lg' : 'md'} variant="primary">
          {dict.home.submit}
        </Button>
      </div>

      {suggestionsOpen && value === '' ? (
        <ul
          id={`${inputId}-suggestions`}
          role="listbox"
          className="absolute left-0 top-full z-30 mt-2 grid w-full gap-1.5 rounded-2xl border border-line bg-surface p-3 shadow-xl"
        >
          {suggestions.slice(0, 6).map((prompt) => (
            <li key={prompt.key}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => submitValue(prompt.query)}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink-strong"
              >
                <Icon name="quote" size={14} className="shrink-0 text-ai" />
                <span className="min-w-0 truncate">{prompt.query}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
