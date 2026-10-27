'use client';

import * as React from 'react';
import { cx, useRovingFocus, useUniqueId } from '../utils';

/**
 * Tabs — WAI-ARIA tabs pattern (roving tabindex, arrow keys, Home/End, optional
 * vertical orientation). Controlled (`value`/`onValueChange`) or uncontrolled (`defaultValue`).
 */
export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  children: React.ReactNode;
  /** Accessible name of the tablist (required when the tabs are the only nav on screen). */
  'aria-label'?: string;
}

interface TabsContextValue {
  value: string | undefined;
  setValue: (v: string) => void;
  orientation: 'horizontal' | 'vertical';
  baseId: string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs(caller: string) {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error(`${caller} must be rendered inside <Tabs>`);
  return ctx;
}

export function Tabs({
  value: controlled,
  defaultValue,
  onValueChange,
  orientation = 'horizontal',
  className,
  children,
  'aria-label': ariaLabel,
}: TabsProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const value = controlled ?? uncontrolled;
  const baseId = useUniqueId('tabs');
  return (
    <TabsContext.Provider
      value={{
        value,
        setValue: (next: string) => {
          if (controlled === undefined) setUncontrolled(next);
          onValueChange?.(next);
        },
        orientation,
        baseId,
      }}
    >
      <div className={cx(orientation === 'vertical' && 'flex gap-4', className)} aria-label={ariaLabel}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabList({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  const { orientation, baseId, value } = useTabs('TabList');
  const ref = React.useRef<HTMLDivElement>(null);
  const { onKeyDown } = useRovingFocus(ref);
  return (
    <div
      ref={ref}
      role="tablist"
      id={`${baseId}-list`}
      aria-orientation={orientation}
      onKeyDown={onKeyDown}
      className={cx(
        'flex gap-1 overflow-x-auto no-scrollbar',
        orientation === 'vertical' && 'flex-col overflow-visible',
        className,
      )}
      {...rest}
    >
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        const selected = (child.props as { value?: string }).value === value;
        return React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
          selected,
          baseId,
          orientation,
        });
      })}
    </div>
  );
}

export function Tab({
  value,
  selected,
  baseId,
  orientation,
  disabled,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  value: string;
  selected?: boolean;
  baseId?: string;
  orientation?: 'horizontal' | 'vertical';
}) {
  return (
    <button
      type="button"
      role="tab"
      id={baseId ? `${baseId}-tab-${value}` : undefined}
      aria-selected={selected ?? false}
      aria-controls={baseId ? `${baseId}-panel-${value}` : undefined}
      tabIndex={selected ? 0 : -1}
      data-roving-item
      data-disabled={disabled ? 'true' : undefined}
      disabled={disabled}
      className={cx(
        'relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-md px-3.5 py-2.5 text-sm font-medium',
        'transition-colors duration-quick ease-nexusOut focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        orientation === 'vertical' && 'rounded-md',
        selected
          ? 'text-ink-strong'
          : 'text-ink-muted hover:bg-surface-muted hover:text-ink-strong',
        disabled && 'cursor-not-allowed opacity-45',
        className,
      )}
      {...rest}
    >
      <React.Fragment key="tab-content">{children}</React.Fragment>
      {selected ? (
        <span
          aria-hidden
          className={cx(
            'absolute bg-accent',
            orientation === 'vertical' ? 'inset-y-2 -left-1 w-0.5 rounded-full' : 'inset-x-2 -bottom-px h-0.5 rounded-full',
          )}
        />
      ) : null}
    </button>
  );
}

export function TabPanel({
  value,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { value: string }) {
  const { baseId, value: active } = useTabs('TabPanel');
  if (active !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      tabIndex={0}
      className={cx('mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', className)}
      {...rest}
    >
      {children}
    </div>
  );
}
