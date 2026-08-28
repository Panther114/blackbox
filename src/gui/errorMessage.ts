function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toGuiErrorMessage(error: unknown): string {
  const cleaned = messageFrom(error)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();

  if (/No automation browser is available|No automation browser is installed|Executable doesn't exist|Looks like Playwright was just installed|playwright.*browser.*(missing|not installed)/i.test(cleaned)) {
    return 'No automation browser is installed. Install Microsoft Edge or Playwright Chromium, then retry.';
  }
  if (/browser is already running|profile is already in use/i.test(cleaned)) {
    return 'The Blackboard browser is already running. Finish or close the other Blackbox operation, then retry.';
  }
  if (/local browser could not start|target page, context or browser has been closed|crashpad.*settings version is not 1|process did exit:\s*exitCode=21|launchPersistentContext/i.test(cleaned)) {
    return 'The local browser could not start. Close other Blackbox or Chromium windows and retry. If the problem persists, run Diagnostics.';
  }
  if (/page\.goto:\s*Timeout|navigation timeout|Timeout \d+ms exceeded.*waiting until "commit"|ERR_CONNECTION_(REFUSED|TIMED_OUT|RESET)|ERR_NAME_NOT_RESOLVED|ENETUNREACH|ECONNREFUSED|ETIMEDOUT/i.test(cleaned)) {
    return 'Blackboard did not respond while opening the login page. Check your connection or VPN, then retry.';
  }
  return cleaned || 'The requested action could not be completed.';
}
