'use client';

import { useEffect, useRef, useState } from 'react';

import { accumulateWheelDelta, classifyWheelPair, WHEEL_ADVANCE, type WheelVerdict } from '@/lib/wheel-check';

export type WheelCheckLabels = {
  eyebrow: string;
  title: string;
  hint: string;
  zoneHint: string;
  start: string;
  downTrack: string;
  upTrack: string;
  normal: string;
  inverted: string;
  inconclusive: string;
  retry: string;
  downLabel: string;
  upLabel: string;
  stepDown: string;
  stepUp: string;
  stepVerdict: string;
};

type Stage = 'idle' | 'down' | 'up' | 'done';

const ADVANCE = WHEEL_ADVANCE;

/**
 * D1283 — the wheel-direction self-test. Not a fix: the OS owns the wheel's sign and the
 * product cannot flip it back. This card answers the only question the product can honestly
 * answer — which side of the line the fault lives on — in one scroll pass.
 *
 * While the test is armed a capture-phase window listener hears every wheel event on the page
 * (the reader never has to park the cursor in a box), swallows them so the page does not run
 * away mid-check, and hands the wheel straight back the moment the verdict renders.
 */
export function WheelCheck({ labels }: { labels: WheelCheckLabels }) {
  const [stage, setStage] = useState<Stage>('idle');
  const [down, setDown] = useState(0);
  const [up, setUp] = useState(0);
  const [verdict, setVerdict] = useState<WheelVerdict>('inconclusive');
  // Refs so the capture listener always sees the live accumulators, never a stale closure.
  const stateRef = useRef({ stage, down, up });
  stateRef.current = { stage, down, up };

  useEffect(() => {
    if (stage === 'idle' || stage === 'done') return;

    const onWheel = (event: WheelEvent): void => {
      const current = stateRef.current;
      if (current.stage !== 'down' && current.stage !== 'up') return;
      event.preventDefault(); // the page stays put only while the check is armed; released on the verdict
      if (current.stage === 'down') {
        const next = accumulateWheelDelta(current.down, event.deltaY);
        setDown(next);
        if (Math.abs(next) >= ADVANCE) setStage('up');
        return;
      }
      const next = accumulateWheelDelta(current.up, event.deltaY);
      setUp(next);
      if (Math.abs(next) >= ADVANCE) {
        setVerdict(classifyWheelPair(stateRef.current.down, next));
        setStage('done');
      }
    };

    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  }, [stage]);

  const reset = () => {
    setStage('idle');
    setDown(0);
    setUp(0);
    setVerdict('inconclusive');
  };

  const NOTCH = 100;
  const downNotches = Math.floor(Math.abs(down) / NOTCH);
  const upNotches = Math.floor(Math.abs(up) / NOTCH);
  const armed = stage === 'down' || stage === 'up';

  const step = (n: number, label: string, state: 'todo' | 'active' | 'done') => (
    <li className="flex items-center gap-2" key={n}>
      <span
        aria-hidden="true"
        className={
          'grid h-5 w-5 place-items-center rounded-full border text-[10px] font-semibold ' +
          (state === 'done'
            ? 'border-accent bg-accent text-accent-ink'
            : state === 'active'
              ? 'border-accent text-accent'
              : 'border-line text-ink-faint')
        }
      >
        {n}
      </span>
      <span className={state === 'active' ? 'text-ink-strong' : 'text-ink-muted'}>{label}</span>
    </li>
  );

  return (
    <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{labels.eyebrow}</p>
      <h3 className="mt-2 max-w-[36ch] text-lg font-semibold leading-snug text-ink-strong">{labels.title}</h3>
      <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{labels.hint}</p>

      <ol className="mt-4 grid gap-2 text-xs sm:grid-cols-3">
        {step(1, labels.stepDown, stage === 'idle' ? 'todo' : stage === 'down' ? 'active' : 'done')}
        {step(2, labels.stepUp, stage === 'up' ? 'active' : stage === 'done' ? 'done' : 'todo')}
        {step(3, labels.stepVerdict, stage === 'done' ? 'done' : 'todo')}
      </ol>

      <div
        role="status"
        aria-live="polite"
        className="mt-4 rounded-xl border border-dashed border-line bg-canvas px-6 py-6 text-center"
      >
        {stage === 'idle' ? (
          <>
            <p className="text-sm text-ink-muted">{labels.zoneHint}</p>
            <button
              type="button"
              onClick={() => setStage('down')}
              className="mt-3 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover"
            >
              {labels.start}
            </button>
          </>
        ) : stage === 'down' ? (
          <p className="text-sm font-medium text-ink-strong">{labels.downTrack.replace('{n}', String(downNotches))}</p>
        ) : stage === 'up' ? (
          <p className="text-sm font-medium text-ink-strong">{labels.upTrack.replace('{n}', String(upNotches))}</p>
        ) : (
          <p className="text-sm font-semibold leading-relaxed text-ink-strong">
            {verdict === 'normal' ? labels.normal : verdict === 'inverted' ? labels.inverted : labels.inconclusive}
          </p>
        )}
      </div>

      {armed ? (
        <p className="mt-2 text-2xs text-ink-faint">
          {stage === 'down' ? `${labels.downLabel} · ${downNotches}` : `${labels.upLabel} · ${upNotches}`}
        </p>
      ) : null}

      {stage === 'done' ? (
        <button
          type="button"
          onClick={reset}
          className="mt-3 text-xs font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
        >
          {labels.retry}
        </button>
      ) : null}
    </section>
  );
}
