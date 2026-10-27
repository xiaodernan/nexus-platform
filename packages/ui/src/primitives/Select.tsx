'use client';

import * as React from 'react';
import { cx, useEscapeKey, useUniqueId } from '../utils';
import { Icon } from '../icons/Icon';
import { fieldClasses } from './field-classes';

/**
 * Select — listbox pattern with full keyboard support (type-ahead not implemented;
 * Arrow/Home/End/Enter/Escape/Tab are). Native `<select>` is exposed as `SelectNative`
 * for progressive-enhancement forms and for mobile where the OS picker is better UX.
 */
export interface SelectOption {
  value: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  required?: boolean;
  name?: string;
  className?: string;
  containerClassName?: string;
  id?: string;
  'aria-label'?: string;
}

export function Select({
  options,
  value: controlled,
  defaultValue,
  placeholder = 'Select…',
  onChange,
  label,
  hint,
  error,
  size = 'md',
  disabled,
  required,
  name,
  className,
  containerClassName,
  id: idProp,
  ...rest
}: SelectProps) {
  const auto = useUniqueId('select');
  const id = idProp ?? auto;
  const [open, setOpen] = React.useState(false);
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const value = controlled ?? uncontrolled;
  const [activeIndex, setActiveIndex] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const selected = options.find((option) => option.value === value);

  const commit = (next: string) => {
    if (controlled === undefined) setUncontrolled(next);
    onChange?.(next);
    setOpen(false);
  };

  useEscapeKey(open, () => setOpen(false));

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  React.useEffect(() => {
    if (open) {
      const index = options.findIndex((option) => option.value === value);
      setActiveIndex(index >= 0 ? index : 0);
      listRef.current?.focus();
    }
  }, [open, options, value]);

  const moveFocus = (delta: number) => {
    setOpen(true);
    setActiveIndex((current) => {
      let next = current;
      for (let i = 0; i < options.length; i += 1) {
        next = (next + delta + options.length) % options.length;
        if (!options[next]?.disabled) break;
      }
      return next;
    });
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option && !option.disabled) commit(option.value);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div ref={rootRef} className={cx('relative flex flex-col gap-1.5', containerClassName)}>
      {label ? (
        <span id={`${id}-label`} className="text-xs font-medium tracking-wide text-ink-muted">
          <React.Fragment key="select-label">{label}</React.Fragment>
          {required ? <span className="ml-1 text-danger">*</span> : null}
        </span>
      ) : null}
      <button
        type="button"
        id={id}
        name={name}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${id}-list`}
        aria-labelledby={label ? `${id}-label` : undefined}
        aria-label={label ? undefined : rest['aria-label']}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={cx(
          fieldClasses({ size, invalid: error ? true : undefined }),
          'flex items-center justify-between gap-2 text-left',
          !selected && 'text-ink-faint',
          className,
        )}
      >
        <span className="truncate">{selected ? selected.label : placeholder}</span>
        <Icon name="chevronDown" size={16} className={cx('shrink-0 text-ink-faint transition-transform duration-quick', open && 'rotate-180')} />
      </button>

      {open ? (
        <ul
          ref={listRef}
          role="listbox"
          id={`${id}-list`}
          tabIndex={-1}
          aria-labelledby={label ? `${id}-label` : undefined}
          aria-activedescendant={`${id}-option-${activeIndex}`}
          onKeyDown={onListKeyDown}
          className="absolute z-40 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg animate-[nexus-fade-up_140ms_var(--nexus-ease-out)]"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => !option.disabled && commit(option.value)}
                className={cx(
                  'flex cursor-pointer items-start justify-between gap-2 rounded-md px-2.5 py-2 text-sm',
                  index === activeIndex ? 'bg-accent-soft text-accent-soft-ink' : 'text-ink',
                  option.disabled && 'cursor-not-allowed opacity-45',
                )}
              >
                <span className="flex flex-col">
                  <span className="font-medium">{option.label}</span>
                  {option.hint ? <span className="text-xs text-ink-faint">{option.hint}</span> : null}
                </span>
                {isSelected ? <Icon name="check" size={15} className="mt-0.5 shrink-0" /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Native select — use when the browser picker is preferable (mobile filters). */
export function SelectNative({
  options,
  label,
  className,
  containerClassName,
  id: idProp,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  options: Array<{ value: string; label: string }>;
  label?: React.ReactNode;
  containerClassName?: string;
}) {
  const auto = useUniqueId('select-native');
  const id = idProp ?? auto;
  return (
    <div className={cx('flex flex-col gap-1.5', containerClassName)}>
      {label ? (
        <label htmlFor={id} className="text-xs font-medium tracking-wide text-ink-muted">
          {label}
        </label>
      ) : null}
      <div className="relative">
        <select
          id={id}
          className={cx(fieldClasses({ size: 'md' }), 'appearance-none pr-10', className)}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon
          name="chevronDown"
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint"
        />
      </div>
    </div>
  );
}

/** Switch — boolean setting with a labelled hit area (account preferences, filters). */
export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  id: idProp,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const auto = useUniqueId('switch');
  const id = idProp ?? auto;
  return (
    <div className={cx('flex items-start justify-between gap-4', className)}>
      <span className="flex flex-col gap-0.5">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium text-ink-strong">
          {label}
        </label>
        {description ? <span className="text-xs leading-relaxed text-ink-faint">{description}</span> : null}
      </span>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cx(
          'relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-base ease-nexusOut',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-surface-sunken',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span
          aria-hidden
          className={cx(
            'absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow-sm transition-transform duration-base ease-nexusSpring',
            checked ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}
