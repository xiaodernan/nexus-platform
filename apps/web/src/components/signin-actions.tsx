'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import type { Locale } from '@/lib/i18n';
import { getDict } from '@/lib/i18n';

const ROLES = ['merchant', 'consumer', 'admin'] as const;
type Role = (typeof ROLES)[number];

/**
 * The sign-in buttons for `/signin`. POSTs the chosen role to the BFF, which forwards the platform's
 * `Set-Cookie` headers back; navigates to the right landing page once the platform confirms the session.
 */
export function SignInActions({ locale }: { locale: string }) {
  const dict = getDict(locale as Locale);
  const router = useRouter();
  const [pending, setPending] = useState<Role | 'signout' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The platform refuses with 403 when `nexus.demo.login-enabled=false`; that is a stated
  // deployment decision, not a failed attempt, so it renders the explanation instead of the desk.
  const [denied, setDenied] = useState(false);

  const submit = async (role: Role) => {
    setPending(role);
    setNotice(null);
    try {
      const res = await fetch('/api/nexus/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
        credentials: 'same-origin',
      });
      const text = await res.text();
      let parsed: { error?: { code?: string; message?: string } } | null = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* noop */ }
      if (res.status === 403) {
        setDenied(true);
        setPending(null);
        return;
      }
      if (!res.ok) {
        setNotice(dict.signin.failed(parsed?.error?.code ?? `HTTP ${res.status}`));
        setPending(null);
        return;
      }
      setNotice(dict.signin.success(dict.signin.roles[role]));
      // Brief pause so the notice paints before the navigation
      await new Promise((resolve) => setTimeout(resolve, 400));
      router.push(role === 'merchant' ? '/merchant' : role === 'admin' ? '/admin' : '/');
      router.refresh();
    } catch {
      setNotice(dict.signin.failed('network'));
      setPending(null);
    }
  };

  const signOut = async () => {
    setPending('signout');
    setNotice(null);
    try {
      await fetch('/api/nexus/auth', { method: 'DELETE', credentials: 'same-origin' });
      setNotice(dict.signin.signedOut);
      setPending(null);
      router.refresh();
    } catch {
      setNotice(dict.signin.failed('network'));
      setPending(null);
    }
  };

  if (denied) {
    return (
      <div role="alert" className="rounded-lg border border-line bg-surface px-4 py-3">
        <p className="text-sm font-semibold text-ink-strong">{dict.signin.deniedTitle}</p>
        <p className="mt-1 text-xs text-ink-muted">{dict.signin.deniedBody}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {ROLES.map((role) => {
          const hint = role === 'merchant' ? dict.signin.merchantHint : role === 'consumer' ? dict.signin.consumerHint : dict.signin.adminHint;
          const label = dict.signin.roles[role];
          const busy = pending === role;
          return (
            <li key={role}>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => submit(role)}
                className="flex w-full items-start justify-between gap-4 rounded-lg border border-line bg-surface px-4 py-3 text-left transition hover:border-accent hover:bg-accent-soft/40 disabled:opacity-50"
              >
                <span className="flex flex-col">
                  <span className="text-sm font-semibold text-ink-strong">{label}</span>
                  <span className="text-xs text-ink-muted">{hint}</span>
                </span>
                <span className="text-xs font-medium text-accent">{busy ? dict.signin.submitting : dict.signin.submit}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        disabled={pending !== null}
        onClick={signOut}
        className="self-start rounded-md border border-line px-3 py-1.5 text-xs text-ink-muted hover:border-line-strong hover:text-ink-strong disabled:opacity-50"
      >
        {pending === 'signout' ? dict.signin.signingOut : dict.signin.signOut}
      </button>
      {notice ? (
        <p role="status" aria-live="polite" className="text-xs text-ink-muted">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
