import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getUniqueFilePath,
  parseContentDisposition,
  releaseReservedPath,
} from '../src/utils/helpers';

describe('helper fixes', () => {
  describe('parseContentDisposition', () => {
    it('captures quoted filenames without swallowing trailing parameters', () => {
      expect(parseContentDisposition('attachment; filename="a.pdf"; size="5"')).toBe('a.pdf');
      expect(parseContentDisposition('attachment; filename="report (final).docx"')).toBe('report (final).docx');
    });

    it('captures RFC 5987 filenames up to the next parameter', () => {
      expect(parseContentDisposition("attachment; filename*=UTF-8''%E8%AF%BE%E7%A8%8B.pdf; foo=bar")).toBe('课程.pdf');
      expect(parseContentDisposition("attachment; filename*=UTF-8''plain.txt")).toBe('plain.txt');
    });

    it('captures unquoted filenames', () => {
      expect(parseContentDisposition('attachment; filename=notes.txt; size=3')).toBe('notes.txt');
    });

    it('returns null for unusable headers', () => {
      expect(parseContentDisposition('')).toBeNull();
      expect(parseContentDisposition('inline')).toBeNull();
    });
  });

  describe('path reservations', () => {
    it('releases reservations so the same path can be reclaimed after deletion', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-reservation-'));
      try {
        const first = getUniqueFilePath(dir, 'report.pdf');
        releaseReservedPath(first);
        // The reservation is gone, and the file does not exist, so the same
        // path must be handed out again instead of "report (1).pdf".
        const second = getUniqueFilePath(dir, 'report.pdf');
        expect(second).toBe(first);
        releaseReservedPath(second);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parks a second concurrent claim of the same name on a numbered path', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-reservation-'));
      try {
        const first = getUniqueFilePath(dir, 'report.pdf');
        const second = getUniqueFilePath(dir, 'report.pdf');
        expect(second).toBe(path.join(dir, 'report (1).pdf'));
        releaseReservedPath(first);
        releaseReservedPath(second);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
