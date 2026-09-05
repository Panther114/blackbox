import { filterCourses } from '../src/workflow/downloadWorkflow';
import { Course } from '../src/types';

function course(id: string, name: string): Course {
  return { id, name, url: `https://example.com/course/${id}`, path: name };
}

describe('course filtering', () => {
  it('applies a valid regex filter', () => {
    const courses = [course('1', 'Math 101'), course('2', 'History 202')];
    expect(filterCourses(courses, { filterPattern: 'Math' })).toHaveLength(1);
  });

  it('tolerates a malformed regex by keeping every course (warned, not silent)', () => {
    const courses = [course('1', 'Math 101'), course('2', 'History 202')];
    expect(filterCourses(courses, { filterPattern: '(unterminated' })).toEqual(courses);
  });

  it('excludes blocked course ids', () => {
    const courses = [course('1', 'Math 101'), course('2', 'History 202')];
    const visible = filterCourses(courses, { excludeCourseIds: ['1'] });
    expect(visible.map(c => c.id)).toEqual(['2']);
  });

  it('extracts course ids from URLs without trailing query parameters', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { extractCourseId } = require('../src/scraper');
    expect(extractCourseId('https://bb.example.com/webapps/course?course_id=_123_1&mode=cpview')).toBe('_123_1');
    expect(extractCourseId('https://bb.example.com/nope')).toBe('');
  });
});
