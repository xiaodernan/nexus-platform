'use client';

import * as React from 'react';
import { cx } from '../utils';
import { Icon, type IconName } from '../icons/Icon';

/* ------------------------------------------------------------------ EmptyState */

/**
 * EmptyState — an honest, designed empty state (§155: "Empty state is a valid state").
 * All copy is injected; components never invent text.
 */
export function EmptyState({
  icon = 'search',
  title,
  description,
  action,
  className,
}: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface-muted/40 px-6 py-12 text-center',
        className,
      )}
    >
      <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-surface text-ink-faint shadow-xs">
        <Icon name={icon} size={19} />
      </span>
      <p className="text-base font-semibold text-ink-strong">{title}</p>
      {description ? <p className="max-w-sm text-sm leading-relaxed text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-3 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ ErrorState */

export function ErrorState({
  title,
  description,
  requestId,
  retryAction,
  hint,
  tone = 'danger',
  className,
}: {
  title: string;
  description?: string;
  requestId?: string | null;
  retryAction?: React.ReactNode;
  hint?: string;
  tone?: 'danger' | 'warning';
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-col items-start gap-2 rounded-lg border p-4 sm:p-5',
        tone === 'danger' ? 'border-danger/35 bg-danger-soft' : 'border-warning/40 bg-warning-soft',
        className,
      )}
    >
      <span className="flex items-center gap-2">
        <Icon name="warning" size={17} className={tone === 'danger' ? 'text-danger' : 'text-warning'} />
        <span className={cx('text-sm font-semibold', tone === 'danger' ? 'text-danger' : 'text-warning')}>{title}</span>
      </span>
      {description ? <p className="text-sm leading-relaxed text-ink">{description}</p> : null}
      {hint ? <p className="text-xs leading-relaxed text-ink-muted">{hint}</p> : null}
      <span className="flex flex-wrap items-center gap-3">
        <React.Fragment key="error-retry">{retryAction}</React.Fragment>
        {requestId ? (
          <span className="font-mono text-2xs text-ink-faint">request_id: {requestId}</span>
        ) : null}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------- LoadingStage */

export type StageState = 'pending' | 'active' | 'done' | 'failed';

export interface Stage {
  key: string;
  label: string;
  state: StageState;
}

/**
 * LoadingStage — the streamed pipeline view (§116). It shows user-legible status strings
 * only ("理解需求…", "搜索中…") — never reasoning. Completed stages stay listed, which is
 * what makes "AI did 3 things in 800ms" comprehensible without a spinner.
 *
 * `degraded` renders the §105 fallback notice: results came from the deterministic path,
 * not the model, and the UI must say so.
 */
export function LoadingStage({
  stages,
  degraded,
  degradedLabel,
  liveLabel = 'Status',
  className,
}: {
  stages: Stage[];
  degraded?: boolean;
  degradedLabel?: string;
  liveLabel?: string;
  className?: string;
}) {
  return (
    <ol
      aria-label={liveLabel}
      aria-busy={stages.some((stage) => stage.state === 'active') || undefined}
      className={cx('flex flex-col gap-2', className)}
    >
      {stages.map((stage) => (
        <li key={stage.key} className="flex items-center gap-2.5 text-sm">
          <span
            className={cx(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
              stage.state === 'done' && 'border-positive/40 bg-positive-soft text-positive',
              stage.state === 'active' && 'border-accent/45 bg-accent-soft text-accent',
              stage.state === 'pending' && 'border-line-strong text-ink-disabled',
              stage.state === 'failed' && 'border-danger/40 bg-danger-soft text-danger',
            )}
          >
            {stage.state === 'done' ? (
              <Icon name="check" size={12} />
            ) : stage.state === 'failed' ? (
              <Icon name="close" size={12} />
            ) : stage.state === 'active' ? (
              <span className="flex gap-0.5">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="nexus-pulse h-1 w-1 rounded-full bg-current [animation:nexus-pulse-dot_1.05s_ease-in-out_infinite]"
                    style={{ animationDelay: `${dot * 130}ms` }}
                  />
                ))}
              </span>
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
            )}
          </span>
          <span
            className={cx(
              'truncate',
              stage.state === 'active' ? 'font-medium text-ink-strong' : stage.state === 'pending' ? 'text-ink-faint' : 'text-ink-muted',
            )}
          >
            {stage.label}
          </span>
        </li>
      ))}
      {degraded ? (
        <li className="mt-1 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-2.5 py-2 text-xs text-warning">
          <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
          <span>{degradedLabel}</span>
        </li>
      ) : null}
    </ol>
  );
}

/** Thin top-of-page progress bar for route transitions. */
export function ProgressBar({ label }: { label: string }) {
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      className="fixed inset-x-0 top-0 z-[80] h-0.5 overflow-hidden bg-transparent"
    >
      <span className="absolute inset-y-0 left-0 w-1/3 bg-accent [animation:nexus-shimmer_1.15s_ease-in-out_infinite]" />
    </span>
  );
}
