'use client';

/**
 * SearchBox — the natural-language entry point (§6). It is a form, not a button: Enter submits,
 * the IME composition state must not fire a submit mid-word, and the example prompts are real
 * queries rather than decoration.
 */

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button, Icon, cx, useUniqueId } from '@nexus/ui';
import { getDict } from '@/lib/i18n';

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
  // Two boxes can be mounted at once (the results page has a top box and a follow-up box), so the
  // label/id pair must be per instance rather than a constant.
  const inputId = useUniqueId('nexus-search');
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialQuery);
  const composing = useRef(false);
  const name = label ?? dict.home.searchLabel;
  const hint = placeholder ?? dict.home.searchPlaceholder;

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

  return (
    <form
      onSubmit={submit}
      role="search"
      {...(onSubmitQuery ? {} : { action: '/search', method: 'get' as const })}
      className={cx('flex w-full items-center gap-2', size === 'lg' ? 'sm:gap-3' : '')}
    >
      <label className="nexus-sr-only" htmlFor={inputId}>
        {name}
      </label>
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
          onChange={(event) => setValue(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            // A Chinese IME fires Enter while committing a word; the finished string must be the
            // only thing that submits, so the default form submission is cancelled mid-composition.
            if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing)) event.preventDefault();
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
    </form>
  );
}
