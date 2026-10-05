import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '../bridge';

/** Caption buttons for the frameless Tauri window. Electron draws its own, so this renders nothing there. */
export function WindowControls() {
  if (!isTauri) return null;
  const win = getCurrentWindow();
  return (
    <div className="window-controls">
      <button type="button" aria-label="Minimize" onClick={() => void win.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button type="button" aria-label="Maximize or restore" onClick={() => void win.toggleMaximize()}>
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button type="button" className="is-close" aria-label="Close" onClick={() => void win.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
    </div>
  );
}
