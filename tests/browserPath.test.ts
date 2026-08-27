import { getBundledChromiumRelativeCandidates } from '../src/auth/browserPath';

describe('bundled Chromium paths', () => {
  it('resolves the Windows executable layout', () => {
    expect(getBundledChromiumRelativeCandidates('win32', 'x64')).toEqual([
      'chrome-win64/chrome.exe',
      'chrome-win/chrome.exe',
    ]);
  });

  it('resolves the macOS Chrome for Testing layout for both architectures', () => {
    expect(getBundledChromiumRelativeCandidates('darwin', 'x64')[0]).toContain('chrome-mac-x64/Google Chrome for Testing.app');
    expect(getBundledChromiumRelativeCandidates('darwin', 'arm64')[0]).toContain('chrome-mac-arm64/Google Chrome for Testing.app');
  });

  it('resolves both Linux Chromium layouts', () => {
    expect(getBundledChromiumRelativeCandidates('linux', 'x64')).toEqual([
      'chrome-linux64/chrome',
      'chrome-linux/chrome',
    ]);
  });
});
