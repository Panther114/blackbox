import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * Inside the Tauri shell there is no Electron preload, so provide the same
 * `window.blackboxGui` bridge over Tauri commands. Every call goes through one
 * Rust command (`bridge`), which keeps the UI code identical across shells.
 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

if (isTauri && !window.blackboxGui) {
  document.documentElement.dataset.shell = 'tauri';
  const bridge = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === 'onWorkflowEvent') {
          return (handler: (event: unknown) => void) => {
            let stop: (() => void) | undefined;
            void listen('workflow:event', event => handler(event.payload)).then(unlisten => (stop = unlisten));
            return () => stop?.();
          };
        }
        return (...args: unknown[]) => invoke('bridge', { method: name, args });
      },
    },
  );
  window.blackboxGui = bridge as Window['blackboxGui'];
  // An explicit ?material= (used by review captures) wins over what the shell reports.
  if (!new URLSearchParams(window.location.search).has('material')) {
    void invoke<{ material: string }>('shell_info').then(info => {
      document.documentElement.dataset.material = info.material;
    });
  }
}
