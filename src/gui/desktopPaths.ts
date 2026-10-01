import path from 'path';

/** Folder metadata must be available before the user configures credentials. */
export function getDesktopPaths(settings: { downloadDir: string }, appPaths: { logsDir: string }) {
  return {
    downloads: path.resolve(settings.downloadDir),
    logs: path.resolve(appPaths.logsDir),
    summary: path.join(appPaths.logsDir, 'latest-summary.txt'),
  };
}
