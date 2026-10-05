import path from 'path';
import { DownloadWorkflow } from '../src/workflow/downloadWorkflow';
import { Config } from '../src/types';

describe('download folder changed after the scan', () => {
  const oldDir = path.resolve('scan-time-dir');
  const newDir = path.resolve('chosen-later-dir');

  function workflow(): DownloadWorkflow {
    return new DownloadWorkflow({ downloadDir: oldDir } as Config);
  }

  it('re-roots scanned save paths into the folder currently chosen in Settings', () => {
    const run = workflow();
    const reroot = run.retargetDownloadDir(newDir);
    expect(run.getDownloadDir()).toBe(newDir);
    expect(reroot(path.join(oldDir, 'Math', 'Week 1'))).toBe(path.join(newDir, 'Math', 'Week 1'));
    expect(reroot(oldDir)).toBe(oldDir);
    const elsewhere = path.resolve('somewhere-else', 'Math');
    expect(reroot(elsewhere)).toBe(elsewhere);
  });

  it('leaves everything alone when the folder did not change', () => {
    const run = workflow();
    const same = run.retargetDownloadDir(oldDir.toUpperCase() === oldDir ? oldDir : oldDir);
    const target = path.join(oldDir, 'Math');
    expect(same(target)).toBe(target);
    expect(run.getDownloadDir()).toBe(oldDir);
  });
});
