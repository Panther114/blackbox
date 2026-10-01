import path from 'path';
import { getDesktopPaths } from '../src/gui/desktopPaths';

describe('first-run desktop folder metadata', () => {
  it('returns folders with no username or password configured', () => {
    const logsDir = path.resolve('local-app-data', 'logs');
    expect(getDesktopPaths({ downloadDir: path.resolve('Downloads', 'Blackbox') }, { logsDir })).toEqual({
      downloads: path.resolve('Downloads', 'Blackbox'),
      logs: logsDir,
      summary: path.join(logsDir, 'latest-summary.txt'),
    });
  });

  it('keeps the configured download directory independent from application logs', () => {
    const configured = path.resolve('different-drive', 'course-materials');
    const logsDir = path.resolve('portable-profile', 'logs');
    const result = getDesktopPaths({ downloadDir: configured }, { logsDir });
    expect(result.downloads).toBe(configured);
    expect(result.logs).toBe(logsDir);
    expect(result.summary).toBe(path.join(logsDir, 'latest-summary.txt'));
  });
});
