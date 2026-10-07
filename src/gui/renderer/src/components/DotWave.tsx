import React, { useEffect, useRef, useState } from 'react';
import { isTauri } from '../bridge';
import { createDotWave, DotWave as DotWaveController, DotWaveMode } from './waveEngine';

const STORAGE_KEY = 'blackbox.dotwave';
const EVENT = 'blackbox:dotwave-mode';
/** After this long out of focus the GPU surface is freed entirely; it is rebuilt the moment the window is used again. */
const RELEASE_AFTER_MS = (Number(new URLSearchParams(window.location.search).get('idle')) || 20) * 1000;

export function readDotWaveMode(): DotWaveMode {
  try {
    const params = new URLSearchParams(window.location.search).get('dots');
    if (params === '0' || params === 'off') return 'off';
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'on' || stored === 'reduced' || stored === 'off') return stored;
  } catch {
    // Storage can be unavailable; the default applies.
  }
  return 'on';
}

export function saveDotWaveMode(mode: DotWaveMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // The choice still applies for this session.
  }
  window.dispatchEvent(new CustomEvent<DotWaveMode>(EVENT, { detail: mode }));
}

/** Whether the window is being used. The page's own focus flag is unreliable in a frameless web view, so the native window's focus events lead there. */
function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    let disposed = false;
    const stops: Array<() => void> = [];
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    stops.push(() => window.removeEventListener('focus', on), () => window.removeEventListener('blur', off));
    if (isTauri) {
      void import('@tauri-apps/api/window')
        .then(async ({ getCurrentWindow }) => {
          const current = getCurrentWindow();
          const stop = await current.onFocusChanged(({ payload }) => setFocused(payload));
          if (disposed) stop();
          else stops.push(stop);
          setFocused(await current.isFocused());
        })
        .catch(() => undefined);
    }
    return () => {
      disposed = true;
      stops.forEach(stop => stop());
    };
  }, []);
  return focused;
}

/** Ambient background. Sits behind everything and never receives input. */
export function DotWave() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wave = useRef<DotWaveController | null>(null);
  const focused = useWindowFocus();
  const [released, setReleased] = useState(false);

  // Out of focus for a while: drop the canvas (and its GPU memory); back in focus: bring it back.
  useEffect(() => {
    if (focused) {
      setReleased(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setReleased(true), RELEASE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [focused]);

  useEffect(() => {
    if (released || !canvas.current) return undefined;
    const controller = createDotWave(canvas.current, readDotWaveMode());
    wave.current = controller;
    controller.setActive(focused);
    const onMode = (event: Event) => controller.setMode((event as CustomEvent<DotWaveMode>).detail);
    window.addEventListener(EVENT, onMode);
    return () => {
      window.removeEventListener(EVENT, onMode);
      controller.dispose();
      wave.current = null;
    };
    // The controller is rebuilt only when the canvas is; focus changes just pause or resume it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [released]);

  useEffect(() => wave.current?.setActive(focused), [focused]);

  return released ? null : <canvas ref={canvas} className="dotwave" aria-hidden="true" />;
}

const LABELS: Record<DotWaveMode, string> = { on: 'On', reduced: 'Still', off: 'Off' };

/** Settings control for the background animation. */
export function DotWaveSetting({ mode, onChange }: { mode: DotWaveMode; onChange: (mode: DotWaveMode) => void }) {
  return (
    <div className="btn-row" role="radiogroup" aria-label="Background animation">
      {(Object.keys(LABELS) as DotWaveMode[]).map(option => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={mode === option}
          className={`action btn-chip ${mode === option ? 'is-on' : ''}`}
          onClick={() => onChange(option)}
        >
          {LABELS[option]}
        </button>
      ))}
    </div>
  );
}
