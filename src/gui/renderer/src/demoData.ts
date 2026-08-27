export type DemoCourse = { id: string; name: string; url: string; path: string };

export type DemoFile = {
  name: string;
  url: string;
  courseName: string;
  sectionName: string;
  savePath: string;
  size?: number;
  fileType?: string;
};

const courseNames = [
  'ACCT 101 - Financial Accounting and Reporting',
  'ARCH 204 - History of East Asian Architecture',
  'BIOL 220 - Cellular Biology and Laboratory Methods',
  'CHEM 115 - General Chemistry: Structure and Reactivity',
  'COMP 312 - Distributed Systems and Cloud Computing',
  'ECON 201 - Microeconomics and Public Policy Analysis',
  'EDUC 301 - Learning Design for Digital Classrooms',
  'ENG 180 - Academic Writing and Research Communication',
  'FIN 330 - Corporate Finance, Valuation and Risk',
  'HIST 242 - Modern China: Society, Culture and Change',
  'INFO 205 - Information Architecture and User Experience',
  'LAW 110 - Legal Systems, Reasoning and Public Institutions',
  'MATH 241 - Applied Statistics for Social Research',
  'MKT 208 - Consumer Behaviour and Brand Strategy',
  'PHYS 130 - Physics of Materials and Everyday Systems',
  'PSYC 210 - Cognitive Psychology and Human Memory',
  'STAT 305 - Data Analysis with Regression Models',
  'WRIT 410 - Capstone Seminar: Evidence, Argument and Style',
];

export const DEMO_COURSES: DemoCourse[] = courseNames.map((name, index) => ({
  id: `demo-course-${index + 1}`,
  name,
  url: `https://blackboard.invalid/course/${index + 1}`,
  path: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));

const fileSeeds = [
  { name: 'Week 01 - Orientation and assessment guide.pdf', type: 'PDF', size: 812_000 },
  { name: 'Week 02 - Core reading notes and lecture slides.pptx', type: 'PPTX', size: 2_640_000 },
  { name: 'Week 03 - Seminar questions and preparation worksheet.docx', type: 'DOCX', size: 428_000 },
  { name: 'Week 04 - Required articles and annotated bibliography.pdf', type: 'PDF', size: 1_340_000 },
  { name: 'Week 05 - Midterm review examples and marking rubric.pdf', type: 'PDF', size: 3_120_000 },
  { name: 'Week 06 - Group project brief and submission checklist.docx', type: 'DOCX', size: 618_000 },
  { name: 'Week 07 - Workshop data set and analysis template.xlsx', type: 'XLSX', size: 1_080_000 },
  { name: 'Week 08 - Reference pack for final presentation.pptx', type: 'PPTX', size: 4_280_000 },
];

export const DEMO_FILES: DemoFile[] = DEMO_COURSES.slice(0, 9).flatMap((course, courseIndex) =>
  fileSeeds.map((seed, fileIndex) => ({
    ...seed,
    url: `https://blackboard.invalid/file/${courseIndex + 1}/${fileIndex + 1}`,
    courseName: course.name,
    sectionName: fileIndex % 2 === 0 ? 'Course Materials' : 'Assessment and Submission Resources',
    savePath: `C:\\Users\\demo\\Downloads\\Blackbox\\${course.path}`,
  })),
);

export const DEMO_SUMMARY = {
  coursesDiscovered: DEMO_COURSES.length,
  coursesSelected: 9,
  filesDiscovered: DEMO_FILES.length,
  filesSelected: DEMO_FILES.length,
  filesDownloaded: 58,
  filesSkipped: 9,
  filesFailed: 5,
  failedFiles: [
    { name: 'Week 04 - Required articles and annotated bibliography.pdf', reason: 'Server did not return the file body' },
    { name: 'Week 07 - Workshop data set and analysis template.xlsx', reason: 'Timed out after 3 attempts' },
  ],
};

export const DEMO_DOCTOR_ROWS = [
  { status: 'pass' as const, message: 'Electron runtime available (offline demo)' },
  { status: 'pass' as const, message: 'GUI build output is present' },
  { status: 'pass' as const, message: 'Automation browser available', required: false },
  { status: 'pass' as const, message: 'Application settings available' },
  { status: 'pass' as const, message: 'Blackboard credentials configured' },
  { status: 'pass' as const, message: 'Download directory writable' },
  { status: 'pass' as const, message: 'Log directory writable' },
  { status: 'pass' as const, message: 'Database directory writable' },
  { status: 'warn' as const, message: 'Blackboard reachability not checked in offline demo', required: false },
  { status: 'warn' as const, message: 'Login test not run in offline demo', required: false },
];

export const DEMO_AGENT_STATUS = {
  configured: true,
  busy: false,
  downloadDir: 'C:\\Users\\demo\\Downloads\\Blackbox',
  codexInstalled: false,
  codexSkillPath: 'C:\\Users\\demo\\.agents\\skills\\blackbox',
};

export const DEMO_AGENT_OUTPUT = {
  manifestPath: 'C:\\Users\\demo\\Downloads\\Blackbox\\agent-export\\manifest.json',
  courses: 9,
  items: 42,
  attachments: 72,
  downloadedFiles: 0,
  warnings: [],
};
