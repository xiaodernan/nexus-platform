'use client';

import { useState } from 'react';
import { Button, Icon, Input, Select } from '@nexus/ui';

import { getDict } from '@/lib/i18n';

/**
 * One human-triggered, destructive-or-publishing action behind an explicit confirm step (§27/§9).
 * Nothing fires on mount: the button opens the confirm panel, and only the confirm button inside it
 * issues the POST. In demo mode the confirm still happens (so the flow is reviewable) and the result
 * line says plainly that no request was sent.
 *
 * Props are plain data on purpose — a `(input) => body` callback cannot cross the Server/Client
 * boundary, so the request body is assembled from serialisable parts: a static `baseBody`, an
 * optional single-choice field, and an optional note field.
 */

export interface ConfirmChoice {
  /** Body key the selected value is written to, e.g. `decision`. */
  key: string;
  label: string;
  options: Array<{ value: string; label: string }>;
}

export interface ConfirmNote {
  /** Body key the note is written to, e.g. `note` / `reason`. */
  key: string;
  label: string;
  hint?: string;
  required?: boolean;
  maxLength?: number;
}

export function ConfirmAction({
  locale,
  endpoint,
  bffPath,
  baseBody,
  choice,
  note,
  label,
  confirmTitle,
  confirmText,
  variant = 'outline',
  size = 'sm',
  disabled = false,
  disabledReason,
}: {
  locale: string;
  /** The documented endpoint, named in the "not wired" and demo copy. */
  endpoint: string;
  /** The BFF path to POST to. Absent ⇒ this action is not wired in this build. */
  bffPath?: string;
  baseBody?: Record<string, unknown>;
  choice?: ConfirmChoice;
  note?: ConfirmNote;
  label: string;
  confirmTitle: string;
  confirmText: string;
  variant?: 'primary' | 'danger' | 'outline';
  size?: 'xs' | 'sm' | 'md';
  disabled?: boolean;
  disabledReason?: string;
}) {
  const dict = getDict(locale);
  const copy = dict.console.common;
  const [open, setOpen] = useState(false);
  const [choiceValue, setChoiceValue] = useState(choice?.options[0]?.value ?? '');
  const [noteValue, setNoteValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; code: string | null } | null>(null);

  const noteMissing = note?.required === true && noteValue.trim() === '';
  const wired = typeof bffPath === 'string' && bffPath.length > 0;

  async function submit() {
    setResult(null);
    const body: Record<string, unknown> = { ...(baseBody ?? {}) };
    if (choice) body[choice.key] = choiceValue;
    if (note && noteValue.trim() !== '') body[note.key] = noteValue.trim();

    if (!wired) {
      // Demo mode: the confirm step ran, the request did not. Saying so is the whole point.
      setBusy(false);
      setOpen(false);
      setResult({ ok: true, code: null });
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(bffPath as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const envelope = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        setResult({ ok: false, code: envelope?.error?.code ?? String(response.status) });
      } else {
        setResult({ ok: true, code: null });
      }
    } catch {
      setResult({ ok: false, code: 'upstream_unreachable' });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={variant}
          size={size}
          shape="md"
          disabled={disabled || !wired}
          title={disabled ? disabledReason : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          {label}
        </Button>
        {disabled && disabledReason ? <span className="text-2xs text-ink-faint">{disabledReason}</span> : null}
      </div>

      {open ? (
        <div className="flex flex-col gap-2 rounded-md border border-warning/70 bg-warning-soft/50 p-3">
          <p className="text-xs font-medium text-ink-strong">{confirmTitle}</p>
          <p className="max-w-2xl text-2xs leading-relaxed text-ink-muted">{confirmText}</p>

          {choice ? (
            <Select
              label={choice.label}
              size="sm"
              value={choiceValue}
              onChange={(value) => setChoiceValue(value)}
              options={choice.options}
            />
          ) : null}

          {note ? (
            <Input
              label={note.label}
              hint={note.hint}
              size="sm"
              required={note.required}
              maxLength={note.maxLength}
              value={noteValue}
              onChange={(event) => setNoteValue(event.target.value)}
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant={variant} size="xs" shape="md" loading={busy} disabled={noteMissing} onClick={() => void submit()}>
              {copy.confirm}
            </Button>
            <Button variant="ghost" size="xs" shape="md" onClick={() => setOpen(false)}>
              {copy.cancel}
            </Button>
          </div>
        </div>
      ) : null}

      {result ? (
        <p className="flex max-w-2xl items-start gap-1.5 text-2xs leading-relaxed text-ink-muted">
          <Icon name={result.ok ? 'info' : 'warning'} size={12} className="mt-0.5 shrink-0" />
          {result.ok
            ? wired
              ? copy.liveActionOk
              : `${copy.demoActionTitle}. ${copy.demoActionText(endpoint)}`
            : copy.actionFailed(result.code ?? 'upstream_unreachable')}
        </p>
      ) : null}

      {!wired && !result ? (
        <p className="max-w-2xl text-2xs leading-relaxed text-ink-faint">{dict.console.notWiredText} {endpoint}</p>
      ) : null}
    </div>
  );
}
