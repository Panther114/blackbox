import { extractCourseId } from '../src/scraper';
import { normalizeBlockedCourses, normalizeCourseId } from '../src/gui/secureStore';

/**
 * Regression tests for course identity.
 *
 * BlackboardChina serves the "My Courses" portlet links through a launcher URL
 * (`...?type=Course&id=_7247_1&url=`) which has no `course_id` parameter. When
 * the id came out empty for every course, all courses shared one identity, so
 * ticking one checkbox selected them all, the blocked-course list stopped
 * matching, and the automation ledger collapsed to a single course.
 */
describe('course id extraction', () => {
  it('reads the course_id parameter of content URLs', () => {
    expect(
      extractCourseId('https://bb.example.com/webapps/course?course_id=_123_1&mode=cpview'),
    ).toBe('_123_1');
  });

  it('reads the id parameter of the My Courses launcher link', () => {
    expect(
      extractCourseId(
        'https://shs.blackboardchina.cn/webapps/blackboard/execute/launcher?type=Course&id=_7247_1&url=',
      ),
    ).toBe('_7247_1');
  });

  it('never returns a trailing url parameter as part of the id', () => {
    expect(
      extractCourseId('https://bb.example.com/webapps/blackboard/execute/launcher?type=Course&id=_6999_1&url='),
    ).not.toContain('&');
  });

  it('reads Ultra course paths', () => {
    expect(extractCourseId('https://bb.example.com/ultra/courses/_5646_1/outline')).toBe('_5646_1');
  });

  it('still returns an empty id when the URL holds no course', () => {
    expect(extractCourseId('https://bb.example.com/nope')).toBe('');
    expect(extractCourseId('')).toBe('');
  });
});

describe('blocked course id normalization', () => {
  it('repairs ids saved by older releases (`_7247_1&url=`)', () => {
    expect(normalizeCourseId('_7247_1&url=')).toBe('_7247_1');
    expect(normalizeCourseId('  _44_1&url=%2Fwebapps  ')).toBe('_44_1');
    expect(normalizeCourseId('_1454_1')).toBe('_1454_1');
  });

  it('keeps blocking entries that now match discovered courses', () => {
    const normalized = normalizeBlockedCourses([
      { id: '_7247_1&url=', name: 'Writing Center 2025-2026' },
      { id: '_7247_1', name: 'Duplicate entry' },
      { id: '', name: 'No id' },
      'not-an-object',
    ]);

    expect(normalized).toEqual([{ id: '_7247_1', name: 'Writing Center 2025-2026' }]);
  });
});
