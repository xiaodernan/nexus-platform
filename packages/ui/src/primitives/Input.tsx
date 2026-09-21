'use client';

import * as React from 'react';
import { cx, useUniqueId } from '../utils';
import { Icon, type IconName } from '../icons/Icon';
import { fieldClasses } from './field-classes';

export interface FieldProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  size?: 'sm' | 'md' | 'lg';
  leadingIcon?: IconName;
  className?: string;
  containerClassName?: string;
}

function FieldShell({
  id,
  label,
  hint,
  error,
  required,
  children,
  containerClassName,
}: {
  id: string;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
  containerClassName?: string;
}) {
  return (
    <div className={cx('flex flex-col gap-1.5', containerClassName)}>
      {label ? (
        <label htmlFor={id} className="text-xs font-medium tracking-wide text-ink-muted">
          {label}
          {required ? (
            <span className="ml-1 text-danger" aria-hidden>
              *
            </span>
          ) : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1.5 text-xs text-danger">
          <Icon name="warning" size={14} />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-ink-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    FieldProps {}

export function Input({
  label,
  hint,
  error,
  required,
  size = 'md',
  leadingIcon,
  className,
  containerClassName,
  id: idProp,
  ...rest
}: InputProps) {
  const auto = useUniqueId('input', idProp);
  const id = idProp ?? auto;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} containerClassName={containerClassName}>
      <div className="relative">
        {leadingIcon ? (
          <Icon
            name={leadingIcon}
            size={18}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint"
          />
        ) : null}
        <input
          id={id}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={cx(
            fieldClasses({ size, invalid: error ? true : undefined }),
            leadingIcon && 'pl-10',
            className,
          )}
          {...rest}
        />
      </div>
    </FieldShell>
  );
}

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    FieldProps {}

export function Textarea({
  label,
  hint,
  error,
  required,
  size = 'md',
  className,
  containerClassName,
  id: idProp,
  rows = 3,
  ...rest
}: TextareaProps) {
  const auto = useUniqueId('textarea', idProp);
  const id = idProp ?? auto;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} containerClassName={containerClassName}>
      <textarea
        id={id}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cx(
          fieldClasses({ size: size === 'lg' ? 'md' : size, invalid: error ? true : undefined }),
          'min-h-[88px] resize-y py-3 leading-relaxed',
          className,
        )}
        {...rest}
      />
    </FieldShell>
  );
}
