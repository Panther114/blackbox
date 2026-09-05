import http from 'http';
import { buildServeArgs, waitForCdpEndpoint } from '../src/auth/obscura';
import { isRetryableDownloadError } from '../src/downloader';

describe('Obscura backend', () => {
  it('builds serve arguments with stealth, proxy and port', () => {
    expect(buildServeArgs({ port: 9223, stealth: true })).toEqual(['serve', '--port', '9223', '--stealth']);
    expect(buildServeArgs({ port: 9300, stealth: false, proxy: 'http://proxy.local:8080' })).toEqual([
      'serve',
      '--port',
      '9300',
      '--proxy',
      'http://proxy.local:8080',
    ]);
  });

  it('waits for a live CDP endpoint', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"Browser":"Obscura"}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      await expect(waitForCdpEndpoint(`http://127.0.0.1:${port}`, 2000)).resolves.toBeUndefined();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('times out when no CDP endpoint answers', async () => {
    await expect(waitForCdpEndpoint('http://127.0.0.1:1', 300)).rejects.toThrow(/did not expose a CDP endpoint/);
  });

  it('classifies download retryability', () => {
    expect(isRetryableDownloadError(new Error('HTTP 500'))).toBe(true);
    expect(isRetryableDownloadError(new Error('HTTP 429'))).toBe(true);
    expect(isRetryableDownloadError(new Error('HTTP 403'))).toBe(false);
    expect(isRetryableDownloadError(new Error('HTTP 404'))).toBe(false);
    expect(isRetryableDownloadError(new Error('write ENOSPC'))).toBe(false);
    expect(isRetryableDownloadError(new Error('socket hang up'))).toBe(true);
  });
});
