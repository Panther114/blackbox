import {
  formatLoginNavigationError,
  isNavigationTimeoutError,
  isTransientNavigationError,
} from '../src/auth';

describe('Blackboard login navigation errors', () => {
  const loginUrl = 'https://shs.blackboardchina.cn/webapps/login/';

  it('treats a goto timeout as recoverable and user-facing', () => {
    const error = new Error('page.goto: Timeout 30000ms exceeded. waiting until "commit"');

    expect(isNavigationTimeoutError(error)).toBe(true);
    expect(isTransientNavigationError(error)).toBe(true);
    expect(formatLoginNavigationError(error, loginUrl)).toContain('did not respond');
  });

  it('explains interrupted Blackboard redirects without exposing Playwright internals', () => {
    const error = new Error('net::ERR_ABORTED; maybe frame was detached');

    expect(isTransientNavigationError(error)).toBe(true);
    expect(formatLoginNavigationError(error, loginUrl)).toContain('changed before it finished loading');
  });
});
