import { toGuiErrorMessage } from '../src/gui/errorMessage';

describe('GUI error messages', () => {
  it('hides Electron and Playwright wrappers for Blackboard timeouts', () => {
    const error = new Error(
      `Error invoking remote method 'workflow:start': Error: page.goto: Timeout 30000ms exceeded. waiting until "commit"`,
    );

    expect(toGuiErrorMessage(error)).toBe(
      'Blackboard did not respond while opening the login page. Check your connection or VPN, then retry.',
    );
  });

  it('preserves useful non-network errors without the remote-method wrapper', () => {
    const error = new Error("Error invoking remote method 'workflow:start': Error: Blackboard credentials are missing.");

    expect(toGuiErrorMessage(error)).toBe('Blackboard credentials are missing.');
  });

  it('explains a missing Playwright browser without exposing its install dump', () => {
    const error = new Error(
      `Error invoking remote method 'setup:save': Error: browserType.launch: Executable doesn't exist at C:\\Users\\admin\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1217\\chrome-headless-shell.exe`,
    );

    expect(toGuiErrorMessage(error)).toBe(
      'No automation browser is installed. Install Microsoft Edge or Playwright Chromium, then retry.',
    );
  });
});
