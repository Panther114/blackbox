import React, { useEffect, useRef } from 'react';
import { createDotWave, DotWave as DotWaveController, DotWaveMode } from './waveEngine';

const STORAGE_KEY = 'blackbox.dotwave';
const EVENT = 'blackbox:dotwave-mode';

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

/** Ambient background. Sits behind everything and never receives input. */
export function DotWave() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvas.current) return;
    const wave: DotWaveController = createDotWave(canvas.current, readDotWaveMode());
    const onMode = (event: Event) => wave.setMode((event as CustomEvent<DotWaveMode>).detail);
    window.addEventListener(EVENT, onMode);
    return () => {
      window.removeEventListener(EVENT, onMode);
      wave.dispose();
    };
  }, []);

  return <canvas ref={canvas} className="dotwave" aria-hidden="true" />;
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
