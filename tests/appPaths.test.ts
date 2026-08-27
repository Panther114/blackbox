import path from 'path';
import os from 'os';
import { getAppDataRoot, getUserConfigRoot } from '../src/appPaths';

describe('portable application paths', () => {
  const originalAppData = process.env.APPDATA;
  const originalXdgConfig = process.env.XDG_CONFIG_HOME;
  const originalOverride = process.env.BLACKBOX_APP_DATA_DIR;
  const originalPlatform = process.platform;

  afterEach(() => {
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfig;
    if (originalOverride === undefined) delete process.env.BLACKBOX_APP_DATA_DIR;
    else process.env.BLACKBOX_APP_DATA_DIR = originalOverride;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('uses an explicit Blackbox data override for portable runs', () => {
    process.env.BLACKBOX_APP_DATA_DIR = path.join('C:\\temp', 'blackbox-data');

    expect(getAppDataRoot()).toBe(path.resolve(process.env.BLACKBOX_APP_DATA_DIR));
  });

  it('prefers APPDATA and otherwise returns a real per-user config root', () => {
    process.env.BLACKBOX_APP_DATA_DIR = '';
    process.env.APPDATA = path.join('C:\\temp', 'appdata');
    process.env.XDG_CONFIG_HOME = path.join('C:\\temp', 'xdg');

    expect(getUserConfigRoot()).toBe(path.resolve(process.env.APPDATA));
  });

  it('uses the standard Linux and macOS config roots when platform variables are absent', () => {
    delete process.env.APPDATA;
    delete process.env.XDG_CONFIG_HOME;

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(getUserConfigRoot()).toBe(path.join(os.homedir(), '.config'));

    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    expect(getUserConfigRoot()).toBe(path.join(os.homedir(), 'Library', 'Application Support'));
  });
});
