import { TransferTracker } from '../src/downloader/transfer';

const files = (sizes: Array<number | undefined>) => sizes.map((size, index) => ({ url: `u${index}`, name: `f${index}.pdf`, size }));

describe('transfer progress', () => {
  it('never reaches 100% while a file is still queued or in flight', () => {
    const tracker = new TransferTracker(files([100, 100]), 0);
    tracker.attempt('u0');
    tracker.progress('u0', 100, 10);
    tracker.settle('u0', 'completed');
    expect(tracker.snapshot(20).percent).toBeLessThan(100);
    tracker.attempt('u1');
    tracker.progress('u1', 100, 30);
    expect(tracker.snapshot(40).percent).toBeLessThan(100);
    tracker.settle('u1', 'completed');
    expect(tracker.snapshot(50).percent).toBe(100);
  });

  it('counts skipped, rejected and failed files as handled so the bar can finish', () => {
    const tracker = new TransferTracker(files([100, 100, 100, 100]), 0);
    tracker.settle('u0', 'completed');
    tracker.settle('u1', 'skipped');
    tracker.settle('u2', 'rejected');
    tracker.settle('u3', 'failed');
    const snapshot = tracker.snapshot(10);
    expect(snapshot.percent).toBe(100);
    expect(snapshot).toMatchObject({ completed: 1, skipped: 1, rejected: 1, failed: 1, settled: 4 });
  });

  it('discards the partial bytes of a failed attempt and reports the retry', () => {
    const tracker = new TransferTracker(files([1000]), 0);
    tracker.attempt('u0');
    tracker.progress('u0', 800, 10);
    expect(tracker.snapshot(20).bytes).toBe(800);
    tracker.attempt('u0');
    const snapshot = tracker.snapshot(30);
    expect(snapshot.bytes).toBe(0);
    expect(snapshot.retrying).toBe(1);
  });

  it('caps in-flight progress at the announced size', () => {
    const tracker = new TransferTracker(files([100]), 0);
    tracker.attempt('u0');
    tracker.progress('u0', 5000, 10);
    expect(tracker.snapshot(20).bytes).toBe(100);
    expect(tracker.snapshot(20).percent).toBeLessThan(100);
  });

  it('falls back to a file-count percentage when sizes are mostly unknown', () => {
    const tracker = new TransferTracker(files([undefined, undefined, undefined, 100]), 0);
    tracker.settle('u0', 'completed');
    const snapshot = tracker.snapshot(10);
    expect(snapshot.basis).toBe('files');
    expect(snapshot.percent).toBe(25);
    expect(snapshot.unknownSize).toBe(3);
    expect(snapshot.etaSeconds).toBeNull();
  });

  it('reports the real rate, shows 0 when idle, and only offers an ETA once it is trustworthy', () => {
    const tracker = new TransferTracker(files([10_000_000]), 0);
    tracker.attempt('u0');
    tracker.progress('u0', 1_000_000, 500);
    tracker.progress('u0', 2_000_000, 1500);
    expect(tracker.snapshot(1500).etaSeconds).toBeNull();
    tracker.progress('u0', 4_000_000, 3500);
    const busy = tracker.snapshot(3600);
    expect(busy.speed).toBeGreaterThan(500_000);
    expect(busy.etaSeconds).not.toBeNull();
    expect(tracker.snapshot(60_000).speed).toBe(0);
  });

  it('lists the files being saved right now, most recent first', () => {
    const tracker = new TransferTracker(files([1, 1, 1, 1]), 0);
    ['u0', 'u1', 'u2', 'u3'].forEach(url => tracker.attempt(url));
    tracker.settle('u3', 'completed');
    expect(tracker.snapshot(1).active).toEqual(['f2.pdf', 'f1.pdf', 'f0.pdf']);
  });
});
