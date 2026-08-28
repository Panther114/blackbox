import fs from 'fs';
import path from 'path';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Chromium can exit before Playwright attaches when a persistent profile has
 * stale or incompatible startup state. Keep this narrow so network and
 * authentication errors are never treated as profile corruption.
 */
export function isPersistentContextStartupError(error: unknown): boolean {
  const message = errorMessage(error);
  return /target page, context or browser has been closed|process did exit:\s*exitCode=\d+|crashpad.*settings version is not 1/i.test(
    message
  );
}

export function isCorruptCrashpadStartupError(error: unknown): boolean {
  return /crashpad.*settings version is not 1/i.test(errorMessage(error));
}

/**
 * Probe Chromium's native profile lock without changing the profile. A stale
 * lock can be repaired; an open lock must be reported and left untouched.
 */
export async function isBrowserProfileInUse(profileDir: string): Promise<boolean> {
  const resolvedProfileDir = path.resolve(profileDir);
  const lockNames = process.platform === 'win32'
    ? ['lockfile']
    : ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

  for (const lockName of lockNames) {
    const lockPath = path.join(resolvedProfileDir, lockName);
    if (!fs.existsSync(lockPath)) continue;
    try {
      const handle = await fs.promises.open(lockPath, 'r+');
      await handle.close();
    } catch (error) {
      if (['EACCES', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) return true;
    }
  }

  return false;
}

function recoveryPath(
  profileDir: string,
  timestamp: Date,
  attempt: number,
  label = 'recovery'
): string {
  const stamp = timestamp
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  const suffix = attempt === 0 ? '' : `-${attempt}`;
  return path.join(
    path.dirname(profileDir),
    `${path.basename(profileDir)}-${label}-${stamp}${suffix}`
  );
}

async function archiveDirectory(
  sourceDir: string,
  targetBaseDir: string,
  now: Date
): Promise<string | null> {
  if (!fs.existsSync(sourceDir)) return null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const backupDir = recoveryPath(targetBaseDir, now, attempt, 'recovery');
    try {
      await fs.promises.rename(sourceDir, backupDir);
      return backupDir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return null;
    }
  }

  return null;
}

/**
 * Crashpad is disposable browser telemetry state. If its settings file is
 * incompatible, remove only that state first so Blackboard cookies survive.
 */
export async function archiveCorruptCrashpad(
  profileDir: string,
  now: Date = new Date()
): Promise<string | null> {
  const resolvedProfileDir = path.resolve(profileDir);
  const crashpadDir = path.join(resolvedProfileDir, 'Crashpad');
  if (!fs.existsSync(crashpadDir)) return null;
  const backupBaseDir = path.join(
    path.dirname(resolvedProfileDir),
    `${path.basename(resolvedProfileDir)}-crashpad`
  );
  return archiveDirectory(crashpadDir, backupBaseDir, now);
}

/**
 * Preserve a failed persistent profile and recreate its original path. A
 * rename is intentional: it is atomic on the same volume and never destroys
 * the user's cookies or local storage. A locked profile is left untouched.
 */
export async function archiveFailedBrowserProfile(
  profileDir: string,
  now: Date = new Date()
): Promise<string | null> {
  const resolvedProfileDir = path.resolve(profileDir);
  if (!fs.existsSync(resolvedProfileDir)) return null;
  const backupDir = await archiveDirectory(resolvedProfileDir, resolvedProfileDir, now);
  if (!backupDir) return null;
  try {
    await fs.promises.mkdir(resolvedProfileDir, { recursive: true });
  } catch {
    try {
      await fs.promises.rename(backupDir, resolvedProfileDir);
    } catch {
      // Keep the preserved backup if the original location cannot be restored.
    }
    return null;
  }
  return backupDir;
}
