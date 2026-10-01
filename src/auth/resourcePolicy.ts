import { BrowserContext } from 'playwright-core';
import { log } from '../utils/logger';

/**
 * Resource policy for discovery sessions.
 *
 * Blackboard pages pull in a lot that the scraper never reads: course imagery,
 * user avatars, icon fonts, and third-party analytics. Every one of them is a
 * network round trip on top of the HTML that actually carries the course tree
 * and the file links, and they are the main reason a discovery pass over a
 * dozen courses feels slow. Aborting them leaves the DOM (and therefore every
 * selector the scraper uses) untouched.
 *
 * Stylesheets and scripts are deliberately NOT blocked: Blackboard's own
 * navigation and the content list are rendered by them, and anything that hides
 * or shows an element would change what `waitForSelector` sees. Analytics hosts
 * are blocked by name instead, which covers the expensive third-party scripts
 * without guessing about first-party ones.
 *
 * The whole hook is best-effort: if the browser backend does not support
 * request interception (an alternative CDP engine, for example), discovery must
 * still run — just without the speed-up.
 */

/** Resource types that never carry course structure or file links. */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'ping']);

/** Third-party analytics / tracking hosts, matched as substrings of the host. */
const BLOCKED_HOST_FRAGMENTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.google.com',
  'doubleclick.net',
  'googlesyndication.com',
  'hotjar.com',
  'clarity.ms',
  'mouseflow.com',
  'fullstory.com',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'sentry.io',
  'newrelic.com',
  'nr-data.net',
  'optimizely.com',
  'crazyegg.com',
  'quantserve.com',
  'scorecardresearch.com',
  'facebook.net',
  'facebook.com/tr',
  'bat.bing.com',
  'matomo.cloud',
  'piwik.pro',
  'statcounter.com',
  'vwo.com',
  'visualwebsiteoptimizer.com',
];

/** Bookkeeping for the debug log: what the policy saved in this session. */
const blockedCounts = new Map<string, number>();

function isBlockedHost(host: string): boolean {
  return BLOCKED_HOST_FRAGMENTS.some(fragment => host.includes(fragment));
}

/** Abort-requests handler; exported for tests. */
export function shouldBlockRequest(input: { url: string; resourceType: string }): string | null {
  const { url, resourceType } = input;
  if (resourceType === 'document') return null;

  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
    // A document-level fetch of these types is never a resource the scraper
    // needs, so type alone is enough here.
    return `type:${resourceType}`;
  }

  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  if (isBlockedHost(host)) return `host:${host}`;
  return null;
}

/**
 * Install the policy on a browser context. Returns the number of aborted
 * requests tracked so far (best effort, for logging).
 */
export async function installFastResourcePolicy(context: BrowserContext | null): Promise<boolean> {
  const routable = context as unknown as {
    route?: (pattern: string, handler: (route: unknown) => Promise<void>) => Promise<void>;
  };
  if (!context || typeof routable.route !== 'function') return false;

  try {
    await routable.route('**/*', async (route: unknown) => {
      const handled = route as {
        request: () => { url: () => string; resourceType: () => string };
        abort: () => Promise<void>;
        continue: () => Promise<void>;
      };
      const request = handled.request();
      const reason = shouldBlockRequest({ url: request.url(), resourceType: request.resourceType() });

      if (reason) {
        blockedCounts.set(reason, (blockedCounts.get(reason) ?? 0) + 1);
        await handled.abort().catch(() => undefined);
        return;
      }
      await handled.continue().catch(() => undefined);
    });
    log.debug('Fast resource policy installed (images, media, fonts, analytics blocked)');
    return true;
  } catch (error) {
    log.debug(
      `Fast resource policy unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** One-line summary of what the policy blocked, for the end of a discovery run. */
export function resourcePolicySummary(): string {
  if (blockedCounts.size === 0) return 'no requests blocked';
  const total = Array.from(blockedCounts.values()).reduce((sum, count) => sum + count, 0);
  const top = Array.from(blockedCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  return `${total} requests blocked (${top})`;
}
