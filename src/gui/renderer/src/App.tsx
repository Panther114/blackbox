import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { toGuiErrorMessage } from '../../errorMessage';
import {
  DEMO_AGENT_OUTPUT,
  DEMO_AGENT_STATUS,
  DEMO_COURSES,
  DEMO_DOCTOR_ROWS,
  DEMO_FILES,
  DEMO_SUMMARY,
} from './demoData';

type DownloadStage = 'ready' | 'courses' | 'files' | 'download' | 'summary';
type View = 'download' | 'agent' | 'settings';
type SettingsSection = 'credentials' | 'diagnostics' | 'updates';
type Course = { id: string; name: string; url: string; path: string };
type DiscoveredFile = {
  name: string;
  url: string;
  courseName: string;
  sectionName: string;
  savePath: string;
  size?: number;
  fileType?: string;
};
type DoctorRow = { status: 'pass' | 'warn' | 'fail'; message: string; required?: boolean };
type Summary = {
  coursesDiscovered: number;
  coursesSelected: number;
  filesDiscovered: number;
  filesSelected: number;
  filesDownloaded: number;
  filesSkipped: number;
  filesFailed: number;
  failedFiles: Array<{ name: string; reason: string }>;
  instructionCoursesSelected: number;
  instructionsDiscovered: number;
  instructionsDownloaded: number;
  instructionWarnings: string[];
};
type PreparationProgress = { completed: number; total: number; label: string };
type DiscoveryProgress = {
  phase: 'courses' | 'metadata';
  completed: number;
  total: number;
  currentCourse?: string;
  currentSection?: string;
  currentFile?: string;
  filesFound?: number;
  accepted?: number;
};
type InstructionProgress = {
  phase: 'discovery' | 'write';
  completed: number;
  total: number;
  currentCourse?: string;
  currentSection?: string;
  currentTitle?: string;
  itemsFound?: number;
};
type DiagnosticsProgress = {
  running: boolean;
  completed: number;
  total: number;
  current: string;
  loginTest: boolean;
};

type IconName =
  | 'download'
  | 'diagnostics'
  | 'agent'
  | 'updates'
  | 'folder'
  | 'file'
  | 'terminal'
  | 'scan'
  | 'search'
  | 'search-x'
  | 'check'
  | 'check-circle'
  | 'check-square'
  | 'x'
  | 'x-circle'
  | 'key'
  | 'lock'
  | 'monitor'
  | 'eye'
  | 'eye-off'
  | 'open'
  | 'refresh'
  | 'cloud-download'
  | 'clock'
  | 'gauge'
  | 'alert'
  | 'warning'
  | 'info'
  | 'book'
  | 'sliders'
  | 'shield';

const iconPaths: Record<IconName, React.ReactNode> = {
  download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
  diagnostics: <path d="M3 12h4l3-9 4 18 3-9h4" />,
  agent: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="M8.5 10h7M8.5 14h7M8.5 18h4" /></>,
  updates: <><path d="M20 11a8.1 8.1 0 0 0-14.8-4L3 10" /><path d="M3 4v6h6" /><path d="M4 13a8.1 8.1 0 0 0 14.8 4l2.2-3" /><path d="M21 20v-6h-6" /></>,
  folder: <><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z" /><path d="M3.4 10h17.2" /></>,
  file: <><path d="M6 3h7l5 5v13H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M13 3v5h5M8 12h6M8 16h6" /></>,
  terminal: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m7 10 3 2.5L7 15" /><path d="M13 15h4" /></>,
  scan: <><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" /><circle cx="12" cy="12" r="3.5" /><path d="M12 8.5v7M8.5 12h7" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4.2 4.2" /></>,
  'search-x': <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4.2 4.2M8.7 8.7l4.2 4.2M12.9 8.7l-4.2 4.2" /></>,
  check: <path d="m5 12.5 4.2 4.2L19 7" />,
  'check-circle': <><circle cx="12" cy="12" r="8.5" /><path d="m8 12.2 2.7 2.7L16.5 9" /></>,
  'check-square': <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8 12 2.5 2.5L16.5 9" /></>,
  x: <><path d="m6 6 12 12M18 6 6 18" /></>,
  'x-circle': <><circle cx="12" cy="12" r="8.5" /><path d="m9 9 6 6M15 9l-6 6" /></>,
  key: <><circle cx="8.5" cy="15.5" r="3.5" /><path d="m11 13 8-8M15 5l4 4M16.5 8.5l2 2" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" /></>,
  monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  eye: <><path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z" /><circle cx="12" cy="12" r="2" /></>,
  'eye-off': <><path d="m3 3 18 18" /><path d="M10.6 7.2A9.4 9.4 0 0 1 12 7c5.8 0 9 5 9 5a15.5 15.5 0 0 1-3.1 3.5M6.2 6.3C4.2 7.6 3 9.5 3 9.5s3.2 5 9 5c.6 0 1.2-.1 1.8-.2" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  open: <><path d="M14 4h6v6M20 4l-8 8" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
  refresh: <><path d="M20 11a8.1 8.1 0 0 0-14.8-4L3 10" /><path d="M3 4v6h6" /><path d="M4 13a8.1 8.1 0 0 0 14.8 4l2.2-3" /><path d="M21 20v-6h-6" /></>,
  'cloud-download': <><path d="M7.5 18.5H6a4 4 0 1 1 1.7-7.6A5.5 5.5 0 0 1 18 12.5h.5a3 3 0 1 1 0 6H16" /><path d="M12 11v8M8.8 15.8 12 19l3.2-3.2" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5l3.2 1.8" /></>,
  gauge: <><path d="M4.5 17a8.2 8.2 0 1 1 15 0" /><path d="m12 12 4-4M6 18h.01M18 18h.01" /></>,
  alert: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v5M12 16h.01" /></>,
  warning: <><path d="m12 4 8.5 15h-17L12 4Z" /><path d="M12 10v4M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22Z" /><path d="M4 5.5V22M8 7h8M8 11h8" /></>,
  sliders: <><path d="M4 6h6M14 6h6M4 12h2M10 12h10M4 18h10M18 18h2" /><circle cx="12" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="16" cy="18" r="2" /></>,
  shield: <><path d="M12 3.5 19 6v5.5c0 4.3-2.9 7.5-7 9-4.1-1.5-7-4.7-7-9V6Z" /><path d="m9 12 2 2 4-4" /></>,
};

const DEMO_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';
const DEMO_SCREEN = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('screen') : null;

const Icon = React.memo(function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{iconPaths[name]}</svg>;
});

const AppIcon = React.memo(function AppIcon({ className = '' }: { className?: string }) {
  return <img className={`app-icon ${className}`} src="./app-icon.png" alt="" aria-hidden="true" />;
});

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const eta = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '?';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const demoInstructionCount = (courseCount: number): number => courseCount > 0 ? Math.max(courseCount, Math.round((courseCount * 42) / 9)) : 0;
const WIZARD_STEPS = ['Courses', 'Files', 'Download', 'Summary'] as const;
const wizardStepIndex = (stage: DownloadStage): number => stage === 'courses' ? 0 : stage === 'files' ? 1 : stage === 'download' ? 2 : stage === 'summary' ? 3 : -1;
const SAVED_PASSWORD_MASK = '••••••••';

function codexSkillInstalled(info: Record<string, unknown> | null): boolean {
  const nested = info?.codexSkill;
  return Boolean(info?.codexInstalled || (nested && typeof nested === 'object' && (nested as Record<string, unknown>).installed));
}

function codexSkillPath(info: Record<string, unknown> | null): string {
  const nested = info?.codexSkill;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).path === 'string') return String((nested as Record<string, unknown>).path);
  return typeof info?.codexSkillPath === 'string' ? String(info.codexSkillPath) : '';
}

export function App() {
  const [stage, setStage] = useState<DownloadStage>('ready');
  const [activeView, setActiveView] = useState<View>('download');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('credentials');
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isPreparingDownload, setIsPreparingDownload] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [savedPassword, setSavedPassword] = useState('');
  const [passwordStored, setPasswordStored] = useState(false);
  const [passwordReadable, setPasswordReadable] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [hasCredentials, setHasCredentials] = useState(false);
  const [isScanningCourses, setIsScanningCourses] = useState(false);
  const [config, setConfig] = useState({ username: '', password: '', downloadDir: './downloads', headless: true, autoCheckUpdates: true });
  const [paths, setPaths] = useState({ downloads: '', logs: '', summary: '' });
  const [preparationProgress, setPreparationProgress] = useState<PreparationProgress | null>(null);
  const [discoveryProgress, setDiscoveryProgress] = useState<DiscoveryProgress | null>(null);
  const [diagnosticsProgress, setDiagnosticsProgress] = useState<DiagnosticsProgress | null>(null);
  const [doctorRows, setDoctorRows] = useState<DoctorRow[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseSearch, setCourseSearch] = useState('');
  const [selectedCourseIds, setSelectedCourseIds] = useState<Set<string>>(new Set());
  const [selectedInstructionCourseIds, setSelectedInstructionCourseIds] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<DiscoveredFile[]>([]);
  const [fileSearch, setFileSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [selectedFileUrls, setSelectedFileUrls] = useState<Set<string>>(new Set());
  const [knownByUrl, setKnownByUrl] = useState<Map<string, number>>(new Map());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [downloadState, setDownloadState] = useState({ completed: 0, failed: 0, skipped: 0, downloadedBytes: 0, totalKnownBytes: 0, unknownCount: 0, speed: 0, currentFile: '' });
  const [perUrlDownloaded, setPerUrlDownloaded] = useState<Map<string, number>>(new Map());
  const [speedWindow, setSpeedWindow] = useState({ lastTs: Date.now(), bytes: 0 });
  const [selectedRunFileCount, setSelectedRunFileCount] = useState(0);
  const [selectedRunInstructionCourseCount, setSelectedRunInstructionCourseCount] = useState(0);
  const [instructionProgress, setInstructionProgress] = useState<InstructionProgress | null>(null);
  const [agentInfo, setAgentInfo] = useState<Record<string, unknown> | null>(null);
  const [agentOutput, setAgentOutput] = useState<Record<string, unknown> | null>(null);
  const [updateState, setUpdateState] = useState<Record<string, unknown>>({ status: 'idle' });

  const selectedRunUrlSetRef = useRef<Set<string>>(new Set());
  const selectedRunKnownByUrlRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (DEMO_MODE) {
      const demoDownloadDir = 'C:\\Users\\demo\\Downloads\\Blackbox';
      setVersion('1.0.1');
      setConfig(previous => ({ ...previous, username: 'g12345678', password: 'blackboard-demo-password', downloadDir: demoDownloadDir, headless: true, autoCheckUpdates: true }));
      setSavedPassword('blackboard-demo-password');
      setPasswordStored(true);
      setPasswordReadable(true);
      setPasswordError('');
      setHasCredentials(true);
      setPaths({ downloads: demoDownloadDir, logs: `${demoDownloadDir}\\logs`, summary: `${demoDownloadDir}\\logs\\latest-summary.txt` });
      setAgentInfo({ ...DEMO_AGENT_STATUS });
      setUpdateState({ status: 'idle', message: 'You are on the latest version.' });

      if (DEMO_SCREEN === 'courses' || DEMO_SCREEN === 'course-list') {
        setCourses(DEMO_COURSES); setSelectedCourseIds(new Set(DEMO_COURSES.map(course => course.id))); setSelectedInstructionCourseIds(new Set(DEMO_COURSES.map(course => course.id))); setStage('courses');
      } else if (DEMO_SCREEN === 'scan' || DEMO_SCREEN === 'scanning') {
        setCourses(DEMO_COURSES); setSelectedCourseIds(new Set(DEMO_COURSES.map(course => course.id))); setSelectedInstructionCourseIds(new Set(DEMO_COURSES.map(course => course.id))); setStage('courses'); setIsScanningCourses(true);
        setDiscoveryProgress({ phase: 'courses', completed: 7, total: DEMO_COURSES.length, currentCourse: DEMO_COURSES[7].name, currentSection: 'Course Materials', filesFound: 34 });
      } else if (DEMO_SCREEN === 'metadata' || DEMO_SCREEN === 'file-details') {
        setCourses(DEMO_COURSES); setSelectedCourseIds(new Set(DEMO_COURSES.map(course => course.id))); setSelectedInstructionCourseIds(new Set(DEMO_COURSES.map(course => course.id))); setStage('courses'); setIsScanningCourses(true);
        setDiscoveryProgress({ phase: 'metadata', completed: 41, total: DEMO_FILES.length, currentFile: DEMO_FILES[41].name, filesFound: DEMO_FILES.length });
      } else if (DEMO_SCREEN === 'files') {
        setCourses(DEMO_COURSES); setSelectedCourseIds(new Set(DEMO_COURSES.slice(0, 9).map(course => course.id))); setSelectedInstructionCourseIds(new Set(DEMO_COURSES.slice(0, 9).map(course => course.id))); setFiles(DEMO_FILES); setSelectedFileUrls(new Set(DEMO_FILES.map(file => file.url))); setStage('files');
      } else if (DEMO_SCREEN === 'download') {
        const totalKnownBytes = DEMO_FILES.reduce((total, file) => total + (file.size || 0), 0);
        setFiles(DEMO_FILES); setSelectedFileUrls(new Set(DEMO_FILES.map(file => file.url))); setSelectedInstructionCourseIds(new Set(DEMO_COURSES.slice(0, 9).map(course => course.id))); setSelectedRunFileCount(DEMO_FILES.length); setSelectedRunInstructionCourseCount(9); setInstructionProgress({ phase: 'write', completed: 24, total: demoInstructionCount(9), currentCourse: DEMO_COURSES[5].name, currentSection: 'Course Materials', currentTitle: 'Midterm study guide and assessment criteria' });
        setDownloadState({ completed: 31, failed: 1, skipped: 4, downloadedBytes: Math.round(totalKnownBytes * 0.48), totalKnownBytes, unknownCount: 0, speed: 1_820_000, currentFile: DEMO_FILES[35].name }); setStage('download');
      } else if (DEMO_SCREEN === 'summary') {
        setSummary(DEMO_SUMMARY); setStage('summary');
      } else if (DEMO_SCREEN === 'diagnostics') {
        setActiveView('settings'); setSettingsSection('diagnostics'); setDoctorRows(DEMO_DOCTOR_ROWS); setDiagnosticsProgress({ running: false, completed: 10, total: 10, current: 'Diagnostics complete', loginTest: false });
      } else if (DEMO_SCREEN === 'agent') setActiveView('agent');
      else if (DEMO_SCREEN === 'updates') { setActiveView('settings'); setSettingsSection('updates'); }
      else if (DEMO_SCREEN === 'credentials') { setActiveView('settings'); setSettingsSection('credentials'); }
      return;
    }

    if (!window.blackboxGui) { setVersion('dev preview'); return; }
    (async () => {
      try {
        setVersion(await window.blackboxGui.getVersion());
        const cfg = (await window.blackboxGui.loadConfig()) as Record<string, unknown>;
        const loadedPassword = String(cfg.password || '');
        const stored = Boolean(cfg.passwordStored || loadedPassword);
        const readable = Boolean(cfg.passwordReadable ?? loadedPassword);
        const passwordDisplay = loadedPassword || (stored ? SAVED_PASSWORD_MASK : '');
        setConfig(previous => ({ ...previous, username: String(cfg.username || ''), password: passwordDisplay, downloadDir: String(cfg.downloadDir || './downloads'), headless: Boolean(cfg.headless ?? true), autoCheckUpdates: Boolean(cfg.autoCheckUpdates ?? true) }));
        setSavedPassword(loadedPassword);
        setPasswordStored(stored);
        setPasswordReadable(readable);
        setPasswordError(String(cfg.passwordError || ''));
        setHasCredentials(Boolean(cfg.hasCredentials));
        setPaths(await window.blackboxGui.getPaths());
        setUpdateState(await window.blackboxGui.getUpdateState());
      } catch (error) { setErrorMessage(toGuiErrorMessage(error)); }
    })();
  }, []);

  useEffect(() => {
    if (DEMO_MODE || !window.blackboxGui) return;
    const unsub = window.blackboxGui.onWorkflowEvent(evt => {
      const payload = evt.payload as Record<string, unknown>;
      if (evt.type === 'login:start') setPreparationProgress({ completed: 0, total: 3, label: 'Connecting to Blackboard' });
      if (evt.type === 'login:success') setPreparationProgress({ completed: 1, total: 3, label: 'Loading your course list' });
      if (evt.type === 'courses:discovered') setPreparationProgress({ completed: 3, total: 3, label: 'Course list ready' });
      if (evt.type === 'files:discovery:start') setDiscoveryProgress({ phase: 'courses', completed: 0, total: Number(payload.courseCount || selectedCourseIds.size || 0), filesFound: 0 });
      if (evt.type === 'files:discovery:progress') setDiscoveryProgress({ phase: payload.phase === 'metadata' ? 'metadata' : 'courses', completed: Number(payload.completed || 0), total: Number(payload.total || 0), currentCourse: String(payload.currentCourse || ''), currentSection: String(payload.currentSection || ''), filesFound: Number(payload.filesFound || 0) });
      if (evt.type === 'files:metadata:progress') setDiscoveryProgress({ phase: 'metadata', completed: Number(payload.completed || 0), total: Number(payload.total || 0), currentFile: String(payload.currentFile || ''), filesFound: Number(payload.total || 0) });
      if (evt.type === 'files:ready') setDiscoveryProgress(null);
      if (evt.type === 'instructions:discovery:start') setInstructionProgress({ phase: 'discovery', completed: 0, total: Number(payload.courseCount || selectedCourseIds.size || 0), itemsFound: 0 });
      if (evt.type === 'instructions:discovery:progress') setInstructionProgress({ phase: 'discovery', completed: Number(payload.completed || 0), total: Number(payload.total || 0), currentCourse: String(payload.currentCourse || ''), currentSection: String(payload.currentSection || ''), itemsFound: Number(payload.itemsFound || 0) });
      if (evt.type === 'instructions:write:start') setInstructionProgress(previous => ({ phase: 'write', completed: 0, total: Number(payload.instructionsDiscovered || 0), currentCourse: '', currentSection: '', currentTitle: '' }));
      if (evt.type === 'instructions:write:progress') setInstructionProgress({ phase: 'write', completed: Number(payload.completed || 0), total: Number(payload.total || 0), currentCourse: String(payload.currentCourse || ''), currentSection: String(payload.currentSection || ''), currentTitle: String(payload.currentTitle || '') });
      if (evt.type === 'instructions:write:complete') setInstructionProgress(previous => previous ? { ...previous, completed: previous.total, currentTitle: 'Instructions saved' } : previous);
      if (evt.type === 'download:start') {
        const url = String(payload.url || '');
        if (selectedRunUrlSetRef.current.has(url)) setDownloadState(previous => ({ ...previous, currentFile: String(payload.name || payload.filename || '') }));
      }
      if (evt.type === 'download:progress') {
        const url = String(payload.url || '');
        if (selectedRunUrlSetRef.current.has(url)) {
          const downloaded = Number(payload.downloaded || 0);
          setPerUrlDownloaded(previous => {
            const next = new Map(previous);
            const old = next.get(url) || 0;
            if (downloaded > old) {
              const delta = downloaded - old;
              next.set(url, downloaded);
              setSpeedWindow(current => ({ ...current, bytes: current.bytes + delta }));
              const knownSize = selectedRunKnownByUrlRef.current.get(url);
              if (typeof knownSize === 'number') {
                const knownDelta = Math.max(0, Math.min(downloaded, knownSize) - Math.min(old, knownSize));
                if (knownDelta > 0) setDownloadState(current => ({ ...current, downloadedBytes: Math.min(current.totalKnownBytes, current.downloadedBytes + knownDelta) }));
              }
            }
            return next;
          });
        }
      }
      if (evt.type === 'download:complete' || evt.type === 'download:error' || evt.type === 'download:skip') {
        const url = String(payload.url || '');
        if (!url || selectedRunUrlSetRef.current.has(url)) {
          const key: 'completed' | 'failed' | 'skipped' = evt.type === 'download:complete' ? 'completed' : evt.type === 'download:error' ? 'failed' : 'skipped';
          setDownloadState(previous => ({ ...previous, [key]: previous[key] + 1 }));
        }
      }
      if (evt.type === 'diagnostics:progress') setDiagnosticsProgress({ running: Boolean(payload.running), completed: Number(payload.completed || 0), total: Number(payload.total || 0), current: String(payload.current || ''), loginTest: Boolean(payload.loginTest) });
      if (evt.type === 'summary:ready') setSummary(evt.payload as Summary);
      if (evt.type === 'update:state') setUpdateState(evt.payload as Record<string, unknown>);
    });
    return () => unsub();
  }, [selectedCourseIds.size]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setSpeedWindow(previous => {
        const elapsed = (now - previous.lastTs) / 1000;
        if (elapsed < 1) return previous;
        setDownloadState(current => ({ ...current, speed: previous.bytes / elapsed }));
        return { lastTs: now, bytes: 0 };
      });
    }, 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => { if (activeView !== 'settings' || settingsSection !== 'credentials') setShowPassword(false); }, [activeView, settingsSection]);

  const deferredCourseSearch = useDeferredValue(courseSearch);
  const deferredFileSearch = useDeferredValue(fileSearch);
  const visibleCourses = useMemo(() => courses.filter(course => course.name.toLowerCase().includes(deferredCourseSearch.toLowerCase())), [courses, deferredCourseSearch]);
  const selectableFiles = useMemo(() => files.filter(file => {
    const query = `${file.name} ${file.courseName} ${file.sectionName}`.toLowerCase();
    if (deferredFileSearch && !query.includes(deferredFileSearch.toLowerCase())) return false;
    if (typeFilter !== 'all' && (file.fileType || '').toLowerCase() !== typeFilter) return false;
    return true;
  }), [files, deferredFileSearch, typeFilter]);
  const selectedCourses = courses.filter(course => selectedCourseIds.has(course.id));
  const selectedInstructionCourses = selectedCourses.filter(course => selectedInstructionCourseIds.has(course.id));
  const selectedFiles = files.filter(file => selectedFileUrls.has(file.url));
  const progressPercent = downloadState.totalKnownBytes > 0 ? clampPercent((downloadState.downloadedBytes / downloadState.totalKnownBytes) * 100) : selectedRunFileCount > 0 ? clampPercent(((downloadState.completed + downloadState.skipped) / selectedRunFileCount) * 100) : 0;
  const remainingKnownBytes = Math.max(0, downloadState.totalKnownBytes - downloadState.downloadedBytes);
  const countProgress = downloadState.completed + downloadState.skipped;
  const discoveryPercent = discoveryProgress && discoveryProgress.total > 0 ? clampPercent((discoveryProgress.completed / discoveryProgress.total) * 100) : 0;
  const instructionPercent = instructionProgress
    ? instructionProgress.total > 0
      ? clampPercent((instructionProgress.completed / instructionProgress.total) * 100)
      : 100
    : 0;
  const diagnosticsPercent = diagnosticsProgress && diagnosticsProgress.total > 0 ? clampPercent((diagnosticsProgress.completed / diagnosticsProgress.total) * 100) : 0;

  function toggleFileSelection(url: string) {
    setSelectedFileUrls(previous => { const next = new Set(previous); if (next.has(url)) next.delete(url); else next.add(url); return next; });
  }

  async function runWithUiError(action: () => Promise<void>): Promise<void> {
    setErrorMessage('');
    try { await action(); } catch (error) { setStatus(''); setErrorMessage(toGuiErrorMessage(error)); }
  }

  async function openDownloads() {
    if (DEMO_MODE || !window.blackboxGui) { setStatus('Offline demo: the download directory is represented without opening a folder.'); return; }
    const error = await window.blackboxGui.openDownloads(); if (error) setErrorMessage(error);
  }

  async function openLogs() {
    if (DEMO_MODE || !window.blackboxGui) { setStatus('Offline demo: logs are represented without opening a folder.'); return; }
    const error = await window.blackboxGui.openLogs(); if (error) setErrorMessage(error);
  }

  async function chooseDownloadDirectory() {
    if (DEMO_MODE || !window.blackboxGui) { setConfig(previous => ({ ...previous, downloadDir: 'C:\\Users\\demo\\Documents\\Blackbox' })); setStatus('Folder selected. Save settings to keep it.'); return; }
    await runWithUiError(async () => { const selected = await window.blackboxGui.chooseDownloadDirectory(); if (selected) { setConfig(previous => ({ ...previous, downloadDir: selected })); setStatus('Folder selected. Save settings to keep it.'); } });
  }

  async function runDemoPreparation() {
    setIsPreparingDownload(true); setStage('ready'); setSummary(null); setInstructionProgress(null); setSelectedRunInstructionCourseCount(0); setPreparationProgress({ completed: 0, total: 3, label: 'Connecting to Blackboard (offline demo)' }); setStatus('Simulating a Blackboard session. No network request will be made.');
    await delay(650); setPreparationProgress({ completed: 1, total: 3, label: 'Loading your course list' }); await delay(550); setPreparationProgress({ completed: 2, total: 3, label: 'Indexing available courses' }); await delay(750);
    setCourses(DEMO_COURSES); setSelectedCourseIds(new Set(DEMO_COURSES.map(course => course.id))); setSelectedInstructionCourseIds(new Set(DEMO_COURSES.map(course => course.id))); setPreparationProgress({ completed: 3, total: 3, label: 'Course list ready' }); setStage('courses'); setStatus(''); setPreparationProgress(null); setIsPreparingDownload(false);
  }

  async function startFlow() {
    if (isPreparingDownload) return;
    setActiveView('download'); setErrorMessage('');
    if (DEMO_MODE) { await runDemoPreparation(); return; }
    setIsPreparingDownload(true); setStage('ready'); setPreparationProgress({ completed: 0, total: 3, label: 'Connecting to Blackboard' });
    await runWithUiError(async () => {
      setStatus('Connecting to Blackboard and loading your course list...');
      await window.blackboxGui.workflowStart({ username: config.username || undefined, password: config.password || undefined, downloadDir: config.downloadDir, headless: config.headless });
      setPreparationProgress({ completed: 1, total: 3, label: 'Loading your course list' });
      const discovered = await window.blackboxGui.discoverCourses();
      setCourses(discovered); setSelectedCourseIds(new Set(discovered.map(course => course.id))); setSelectedInstructionCourseIds(new Set(discovered.map(course => course.id))); setPreparationProgress({ completed: 3, total: 3, label: 'Course list ready' }); setStage('courses'); setStatus('');
    });
    setIsPreparingDownload(false); setPreparationProgress(null);
  }

  async function beginDownload() { await startFlow(); }

  async function runDemoScan() {
    setDiscoveryProgress({ phase: 'courses', completed: 0, total: selectedCourses.length, filesFound: 0 }); setStatus('');
    for (let index = 0; index < selectedCourses.length; index += 1) {
      await delay(85); setDiscoveryProgress({ phase: 'courses', completed: index + 1, total: selectedCourses.length, currentCourse: selectedCourses[index].name, currentSection: index % 2 === 0 ? 'Course Materials' : 'Assessment Resources', filesFound: Math.min(DEMO_FILES.length, (index + 1) * 4) });
    }
    for (let index = 0; index < DEMO_FILES.length; index += 1) {
      await delay(13); setDiscoveryProgress({ phase: 'metadata', completed: index + 1, total: DEMO_FILES.length, currentFile: DEMO_FILES[index].name, filesFound: DEMO_FILES.length });
    }
    setFiles(DEMO_FILES); setSelectedFileUrls(new Set(DEMO_FILES.map(file => file.url))); setSelectedInstructionCourseIds(new Set(selectedCourses.map(course => course.id))); setKnownByUrl(new Map(DEMO_FILES.map(file => [file.url, file.size || 0]))); setDownloadState({ completed: 0, failed: 0, skipped: 0, downloadedBytes: 0, totalKnownBytes: 0, unknownCount: 0, speed: 0, currentFile: '' }); setSelectedRunFileCount(0); setSelectedRunInstructionCourseCount(0); setInstructionProgress(null); setDiscoveryProgress(null); setStage('files'); setIsScanningCourses(false);
  }

  async function runScanFiles() {
    if (selectedCourses.length === 0 || isScanningCourses) return;
    setActiveView('download'); setIsScanningCourses(true); setErrorMessage('');
    if (DEMO_MODE) { await runDemoScan(); return; }
    await runWithUiError(async () => {
      try {
        setDiscoveryProgress({ phase: 'courses', completed: 0, total: selectedCourses.length, filesFound: 0 }); setStatus('Scanning selected courses for files...');
        const result = (await window.blackboxGui.discoverFiles(selectedCourses)) as { files: DiscoveredFile[] };
        setFiles(result.files); setSelectedFileUrls(new Set(result.files.map(file => file.url))); setSelectedInstructionCourseIds(new Set(selectedCourses.map(course => course.id)));
        const known = new Map<string, number>(); for (const file of result.files) if (typeof file.size === 'number') known.set(file.url, file.size); setKnownByUrl(known);
        setDownloadState({ completed: 0, failed: 0, skipped: 0, downloadedBytes: 0, totalKnownBytes: 0, unknownCount: 0, speed: 0, currentFile: '' }); setPerUrlDownloaded(new Map()); setSelectedRunFileCount(0); setSelectedRunInstructionCourseCount(0); setInstructionProgress(null); selectedRunUrlSetRef.current = new Set(); selectedRunKnownByUrlRef.current = new Map(); setDiscoveryProgress(null); setStage('files'); setStatus('');
      } finally { setIsScanningCourses(false); }
    });
    setIsScanningCourses(false);
  }

  async function runDemoDownload(runFiles: DiscoveredFile[], instructionCourses: Course[]) {
    const totalKnownBytes = runFiles.reduce((total, file) => total + (file.size || 0), 0);
    const instructionTotal = demoInstructionCount(instructionCourses.length);
    const filesFailed = Math.min(DEMO_SUMMARY.filesFailed, runFiles.length);
    const filesSkipped = Math.min(DEMO_SUMMARY.filesSkipped, Math.max(0, runFiles.length - filesFailed));
    const filesDownloaded = Math.max(0, runFiles.length - filesFailed - filesSkipped);

    selectedRunUrlSetRef.current = new Set(runFiles.map(file => file.url));
    selectedRunKnownByUrlRef.current = new Map(runFiles.map(file => [file.url, file.size || 0]));
    setSelectedRunFileCount(runFiles.length);
    setSelectedRunInstructionCourseCount(instructionCourses.length);
    setPerUrlDownloaded(new Map());
    setDownloadState({ completed: 0, failed: 0, skipped: 0, downloadedBytes: 0, totalKnownBytes, unknownCount: 0, speed: 1_820_000, currentFile: '' });
    setInstructionProgress(instructionCourses.length > 0 ? { phase: 'discovery', completed: 0, total: instructionCourses.length, itemsFound: 0 } : null);
    setStage('download');
    setStatus('');

    for (let index = 0; index < instructionCourses.length; index += 1) {
      await delay(80);
      setInstructionProgress({
        phase: 'discovery',
        completed: index + 1,
        total: instructionCourses.length,
        currentCourse: instructionCourses[index].name,
        currentSection: index % 2 === 0 ? 'Course Materials' : 'Assessment Resources',
        itemsFound: instructionTotal > 0 ? Math.round((instructionTotal * (index + 1)) / instructionCourses.length) : 0,
      });
    }

    setInstructionProgress(instructionCourses.length > 0 ? { phase: 'write', completed: 0, total: instructionTotal } : null);
    for (let index = 0; index < instructionTotal; index += 1) {
      await delay(16);
      const course = instructionCourses[index % instructionCourses.length];
      setInstructionProgress({ phase: 'write', completed: index + 1, total: instructionTotal, currentCourse: course.name, currentSection: 'Course Materials', currentTitle: `Instruction item ${index + 1}` });
    }
    if (instructionCourses.length > 0) setInstructionProgress({ phase: 'write', completed: instructionTotal, total: instructionTotal, currentTitle: 'All course instructions saved' });

    for (let index = 0; index < runFiles.length; index += 1) {
      await delay(75);
      const completed = index + 1;
      setDownloadState(previous => ({ ...previous, completed, downloadedBytes: runFiles.length > 0 ? Math.round((totalKnownBytes * completed) / runFiles.length) : 0, currentFile: runFiles[index].name }));
    }

    await delay(250);
    setSummary({
      ...DEMO_SUMMARY,
      coursesSelected: selectedCourses.length,
      filesSelected: runFiles.length,
      filesDownloaded,
      filesSkipped,
      filesFailed,
      failedFiles: DEMO_SUMMARY.failedFiles.slice(0, filesFailed),
      instructionCoursesSelected: instructionCourses.length,
      instructionsDiscovered: instructionTotal,
      instructionsDownloaded: instructionTotal,
      instructionWarnings: [],
    });
    setStage('summary');
  }

  async function startDownload() {
    if (selectedFiles.length === 0 && selectedInstructionCourses.length === 0) return;
    setActiveView('download'); setErrorMessage('');
    if (DEMO_MODE) { await runDemoDownload(selectedFiles, selectedInstructionCourses); return; }
    await runWithUiError(async () => {
      const runSelectedFiles = [...selectedFiles]; const selectedKnownByUrl = new Map<string, number>();
      for (const file of runSelectedFiles) { const knownSize = knownByUrl.get(file.url); if (typeof knownSize === 'number') selectedKnownByUrl.set(file.url, knownSize); else if (typeof file.size === 'number') selectedKnownByUrl.set(file.url, file.size); }
      const runInstructionCourses = [...selectedInstructionCourses];
      const totalKnownBytes = Array.from(selectedKnownByUrl.values()).reduce((total, size) => total + size, 0); selectedRunUrlSetRef.current = new Set(runSelectedFiles.map(file => file.url)); selectedRunKnownByUrlRef.current = selectedKnownByUrl; setSelectedRunFileCount(runSelectedFiles.length); setSelectedRunInstructionCourseCount(runInstructionCourses.length); setPerUrlDownloaded(new Map()); setSpeedWindow({ lastTs: Date.now(), bytes: 0 }); setDownloadState({ completed: 0, failed: 0, skipped: 0, downloadedBytes: 0, totalKnownBytes, unknownCount: runSelectedFiles.length - selectedKnownByUrl.size, speed: 0, currentFile: '' }); setInstructionProgress(runInstructionCourses.length > 0 ? { phase: 'discovery', completed: 0, total: runInstructionCourses.length, itemsFound: 0 } : null); setStatus(''); setStage('download');
      const result = (await window.blackboxGui.downloadFiles(runSelectedFiles, runInstructionCourses)) as Summary; setSummary(result); setStage('summary');
    });
  }

  async function saveSettings(testLogin: boolean) {
    await runWithUiError(async () => {
      const keepStoredPassword = passwordStored && config.password === SAVED_PASSWORD_MASK;
      const passwordToSend = keepStoredPassword ? undefined : config.password;
      const passwordToDisplay = keepStoredPassword ? (savedPassword || SAVED_PASSWORD_MASK) : config.password;
      setStatus(testLogin ? 'Saving settings and testing login...' : 'Saving settings...'); if (DEMO_MODE || !window.blackboxGui) await delay(350); else await window.blackboxGui.saveSetup({ ...config, password: passwordToSend, testLogin }); setSavedPassword(keepStoredPassword ? savedPassword : passwordToDisplay); setPasswordStored(Boolean(passwordToDisplay)); setPasswordReadable(Boolean(keepStoredPassword ? passwordReadable : passwordToDisplay)); setPasswordError(''); setConfig(previous => ({ ...previous, password: passwordToDisplay })); setHasCredentials(Boolean(config.username.trim()) && Boolean(keepStoredPassword ? passwordReadable : passwordToDisplay)); setStatus(testLogin ? 'Settings saved. Login test requested.' : 'Settings saved.');
    });
  }

  async function resetCredentials() {
    await runWithUiError(async () => {
      if (DEMO_MODE || !window.blackboxGui) await delay(250); else await window.blackboxGui.resetSetup(); setHasCredentials(false); setSavedPassword(''); setPasswordStored(false); setPasswordReadable(false); setPasswordError(''); setConfig(previous => ({ ...previous, username: '', password: '' })); setShowPassword(false); setStatus('Credentials reset.');
    });
  }

  async function runDemoDoctor(loginTest: boolean) {
    setDoctorRows([]); const rows = loginTest ? DEMO_DOCTOR_ROWS : DEMO_DOCTOR_ROWS.slice(0, 8); const total = rows.length;
    for (let index = 0; index < rows.length; index += 1) { await delay(150); setDoctorRows(rows.slice(0, index + 1)); setDiagnosticsProgress({ running: index + 1 < total, completed: index + 1, total, current: rows[index].message, loginTest }); }
    setDiagnosticsProgress({ running: false, completed: total, total, current: 'Diagnostics complete', loginTest }); setStatus('');
  }

  async function runDoctor(loginTest = false) {
    setActiveView('settings'); setSettingsSection('diagnostics'); setErrorMessage(''); setDiagnosticsProgress({ running: true, completed: 0, total: loginTest ? 11 : 10, current: 'Starting checks...', loginTest });
    if (DEMO_MODE) { await runDemoDoctor(loginTest); return; }
    await runWithUiError(async () => { setStatus('Running diagnostics...'); const rows = (await window.blackboxGui.runDoctor({ loginTest })) as DoctorRow[]; setDoctorRows(rows); setDiagnosticsProgress(previous => ({ running: false, completed: previous?.total || (loginTest ? 11 : 10), total: previous?.total || (loginTest ? 11 : 10), current: 'Diagnostics complete', loginTest })); setStatus(''); });
  }

  async function loadAgentStatus() {
    setActiveView('agent'); if (DEMO_MODE || !window.blackboxGui) { setAgentInfo(previous => previous || { ...DEMO_AGENT_STATUS }); return; } await runWithUiError(async () => setAgentInfo(await window.blackboxGui.getAgentStatus()));
  }

  async function syncAgent() {
    await runWithUiError(async () => { setStatus(DEMO_MODE ? 'Building a local demo export...' : 'Reading Blackboard instructions and building agent export...'); if (DEMO_MODE || !window.blackboxGui) { await delay(500); setAgentOutput({ ...DEMO_AGENT_OUTPUT }); } else setAgentOutput(await window.blackboxGui.syncAgent({ includeFiles: false, includeInstructions: true })); setStatus('Agent export ready.'); });
  }

  async function installCodex() {
    await runWithUiError(async () => { setStatus(DEMO_MODE ? 'Simulating Codex skill installation...' : 'Installing the Blackbox skill for Codex...'); const result = DEMO_MODE || !window.blackboxGui ? { codexSkill: { ...DEMO_AGENT_STATUS, installed: true, managed: true } } : await window.blackboxGui.installCodexSkill(); await delay(DEMO_MODE ? 300 : 0); setAgentInfo(previous => ({ ...(previous || {}), codexSkill: result.codexSkill, codexInstalled: true })); setStatus('Blackbox is available to Codex. Restart Codex if it does not appear immediately.'); });
  }

  async function removeCodex() {
    await runWithUiError(async () => { setStatus(DEMO_MODE ? 'Simulating Codex skill removal...' : 'Removing the Blackbox skill from Codex...'); const result = DEMO_MODE || !window.blackboxGui ? { codexSkill: { ...DEMO_AGENT_STATUS, installed: false, managed: false } } : await window.blackboxGui.removeCodexSkill(); await delay(DEMO_MODE ? 300 : 0); setAgentInfo(previous => ({ ...(previous || {}), codexSkill: result.codexSkill, codexInstalled: false })); setStatus('Blackbox was removed from Codex.'); });
  }

  async function checkUpdates() {
    setActiveView('settings'); setSettingsSection('updates'); await runWithUiError(async () => { if (DEMO_MODE || !window.blackboxGui) { setUpdateState({ status: 'idle', message: 'You are on the latest version.' }); return; } setUpdateState(await window.blackboxGui.checkForUpdates()); });
  }

  async function downloadAppUpdate() { await runWithUiError(async () => { if (DEMO_MODE || !window.blackboxGui) return; setUpdateState(await window.blackboxGui.downloadUpdate()); }); }

  const fileTypes = Array.from(new Set(files.map(file => (file.fileType || '').toLowerCase()).filter(Boolean)));
  const navItems: Array<{ id: View; label: string; hint: string; icon: React.ReactNode }> = [
    { id: 'download', label: 'Downloads', hint: 'Courses, files and saving', icon: <Icon name="download" size={21} /> },
    { id: 'agent', label: 'Agent Export', hint: 'Read-only tools and Codex', icon: <Icon name="agent" size={21} /> },
    { id: 'settings', label: 'Settings', hint: 'Credentials, diagnostics and updates', icon: <Icon name="sliders" size={21} /> },
  ];

  function onNav(id: View) { setErrorMessage(''); setActiveView(id); if (id === 'agent') void loadAgentStatus(); }
  const activeLabel = navItems.find(item => item.id === activeView)?.label || 'Downloads';
  const activeIcon: IconName = activeView === 'download' ? 'download' : activeView === 'agent' ? 'agent' : 'sliders';
  const codexInstalled = codexSkillInstalled(agentInfo);
  const skillPath = codexSkillPath(agentInfo);
  const showGlobalStatus = Boolean(status) && !(activeView === 'download' && (isPreparingDownload || isScanningCourses || stage === 'download'));

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand"><div className="brand-mark"><AppIcon /></div><div className="brand-text"><strong>Blackbox</strong><span>blackboardchina downloader</span></div></div>
        <nav className="rail-nav" aria-label="Primary">{navItems.map(item => <button key={item.id} className={`rail-item ${activeView === item.id ? 'is-active' : ''}`} aria-label={item.label} aria-current={activeView === item.id ? 'page' : undefined} title={item.hint} onClick={() => onNav(item.id)}><span className="rail-icon">{item.icon}</span><span className="rail-label"><span className="rail-title">{item.label}</span><span className="rail-hint">{item.hint}</span></span></button>)}</nav>
        <div className="rail-foot"><div className="rail-version">v{version || '...'}</div><div className="rail-paths"><button className="linklike" onClick={openDownloads} title={paths.downloads}>Downloads</button><span className="sep">/</span><button className="linklike" onClick={openLogs} title={paths.logs}>Logs</button></div><p className="rail-note">Educational use only. Use responsibly.</p></div>
      </aside>

      <main className="stage">
        <header className="topbar"><div className="topbar-crumb"><h1><Icon name={activeIcon} size={22} /> {activeLabel}</h1></div><div className="topbar-meta"><span className="pill pill-soft">{version || 'Loading...'}</span>{DEMO_MODE && <span className="pill pill-demo">Offline demo</span>}{hasCredentials ? <span className="pill pill-ok"><Icon name="shield" size={14} /> Credentials ready</span> : <span className="pill pill-warn"><Icon name="key" size={14} /> Credentials needed</span>}</div></header>
        {showGlobalStatus && <div className="banner banner-info" role="status"><Icon name="info" size={16} /><span>{status}</span></div>}
        {errorMessage && <div className="banner banner-error" role="alert"><Icon name="alert" size={17} /><span><strong>Something went wrong</strong>{errorMessage}</span></div>}
        {activeView === 'settings' && settingsSection === 'diagnostics' && diagnosticsProgress && <div className="diagnostics-progress-top" data-testid="diagnostics-progress"><ProgressBar label={diagnosticsProgress.running ? (diagnosticsProgress.loginTest ? 'Running diagnostics and login test' : 'Running diagnostics') : 'Diagnostics complete'} value={diagnosticsPercent} detail={`${diagnosticsProgress.completed} / ${diagnosticsProgress.total}`} subdetail={diagnosticsProgress.current} /></div>}

        {activeView === 'download' && stage === 'ready' && isPreparingDownload && <section className="view download-launch" aria-live="polite" data-testid="download-launch"><div className="panel launch-panel"><div className="launch-hero"><div className="launch-visual"><div className="launch-orbit"><AppIcon /></div></div><div className="launch-copy"><h2>Preparing your course list</h2><p>{status || 'Connecting to Blackboard and loading the courses available to you.'}</p></div></div><ProgressBar label={preparationProgress?.label || 'Starting'} value={preparationProgress ? (preparationProgress.completed / preparationProgress.total) * 100 : 8} indeterminate={!preparationProgress} detail={preparationProgress ? `${preparationProgress.completed} of ${preparationProgress.total}` : 'Working'} /><div className="launch-stages">{['Connect', 'Discover courses', 'Choose files'].map((label, index) => { const progress = preparationProgress?.completed || 0; const state = progress > index ? 'done' : progress === index ? 'current' : 'todo'; return <div key={label} className={`launch-stage is-${state}`}><span className="stage-number">{state === 'done' ? <Icon name="check" size={14} /> : index + 1}</span><span>{label}</span></div>; })}</div></div></section>}

        {activeView === 'download' && stage === 'ready' && !isPreparingDownload && <section className="view"><div className="panel ready-panel"><div className="ready-main"><span className="ready-icon"><AppIcon /></span><div><h2>Ready to download</h2><p>Choose courses, review files, and save documents to your configured folder.</p></div></div><div className="ready-actions"><button className="btn-primary btn-lg" onClick={hasCredentials ? beginDownload : () => { setActiveView('settings'); setSettingsSection('credentials'); }}><Icon name={hasCredentials ? 'download' : 'key'} size={17} />{hasCredentials ? 'Start a download' : 'Open credentials'}</button><button className="btn-ghost" onClick={openDownloads}><Icon name="folder" size={17} /> Open downloads</button></div><dl className="ready-meta"><div><dt>Access</dt><dd>{hasCredentials ? 'Credentials ready' : 'Credentials required'}</dd></div><div><dt>Save to</dt><dd className="mono">{paths.downloads || config.downloadDir || '...'}</dd></div></dl></div></section>}

        {activeView === 'settings' && <section className="view settings-view"><nav className="settings-tabs" aria-label="Settings sections">{(['credentials', 'diagnostics', 'updates'] as SettingsSection[]).map(section => <button key={section} className={settingsSection === section ? 'is-active' : ''} onClick={() => setSettingsSection(section)}>{section === 'credentials' ? 'Credentials' : section === 'diagnostics' ? 'Diagnostics' : 'Updates'}</button>)}</nav>
          {settingsSection === 'credentials' && (
            <div className="panel settings-panel" data-testid="credentials-panel">
              <div className="surface-intro"><div><h2>Account access</h2><p>Stored locally on this machine. Your password is kept in the OS secure store.</p></div><span className={`state-badge ${hasCredentials ? 'state-good' : 'state-warn'}`}>{hasCredentials ? 'Ready' : 'Needs setup'}</span></div>
              <div className="form-grid credentials-form">
                <label className="field"><span className="field-label"><Icon name="key" size={14} /> Username / G-number</span><input value={config.username} onChange={event => setConfig(previous => ({ ...previous, username: event.target.value }))} placeholder="g12345678" autoComplete="username" /></label>
                <label className="field"><span className="field-label"><Icon name="lock" size={14} /> Password</span><span className="password-input"><input type={showPassword ? 'text' : 'password'} value={config.password} onFocus={event => { if (config.password === SAVED_PASSWORD_MASK) event.currentTarget.select(); }} onChange={event => { setPasswordStored(false); setPasswordReadable(Boolean(event.target.value)); setPasswordError(''); setConfig(previous => ({ ...previous, password: event.target.value })); }} placeholder="Enter password" autoComplete="current-password" /><button type="button" className="input-action" aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(value => !value)}><Icon name={showPassword ? 'eye-off' : 'eye'} size={17} /></button></span><span className="field-help">{passwordError || (passwordStored ? (passwordReadable ? 'Saved password loaded. It is hidden by default.' : 'A saved password is present but cannot be unlocked on this system. Re-enter it to repair secure storage.') : config.password ? 'Password entered. It is hidden by default.' : 'No password saved yet.')}</span></label>
                <div className="field field-wide"><span className="field-label"><Icon name="folder" size={14} /> Download directory</span><div className="path-editor"><input data-testid="download-directory-input" value={config.downloadDir} onChange={event => setConfig(previous => ({ ...previous, downloadDir: event.target.value }))} /><div className="directory-actions"><button className="btn-secondary" onClick={chooseDownloadDirectory}><Icon name="folder" size={16} /> Choose folder</button><button className="btn-ghost" onClick={openDownloads}><Icon name="open" size={16} /> Open directory</button></div></div><span className="field-help">Files will be saved here. Choose a folder or edit the path, then save settings.</span></div>
                <div className="field field-wide"><span id="browser-mode-label" className="field-label"><Icon name="monitor" size={14} /> Browser mode</span><BrowserModeSlider headless={config.headless} onChange={headless => setConfig(previous => ({ ...previous, headless }))} /><span className="field-help">Headless is the default and keeps the browser hidden. Use Visible when you need to watch a Blackboard sign-in or troubleshoot it.</span></div>
              </div>
              <div className="btn-row"><button className="btn-primary" onClick={() => saveSettings(false)}><Icon name="check" size={17} /> Save settings</button><button className="btn-secondary" onClick={() => saveSettings(true)}><Icon name="shield" size={17} /> Save and test login</button><button className="btn-danger" onClick={resetCredentials}><Icon name="refresh" size={17} /> Reset credentials</button></div>
            </div>
          )}

          {settingsSection === 'diagnostics' && <div className="panel settings-panel" data-testid="diagnostics-panel"><div className="surface-intro"><div><h2>Environment checks</h2><p>If Blackboard is not working, run a check here to pinpoint what is failing.</p></div><span className={`state-badge ${doctorRows.length ? 'state-good' : 'state-neutral'}`}>{doctorRows.length ? `${doctorRows.length} results` : 'Not run'}</span></div><div className="btn-row"><button className="btn-primary" disabled={Boolean(diagnosticsProgress?.running)} onClick={() => runDoctor(false)}><Icon name="scan" size={17} /> Run checks</button><button className="btn-secondary" disabled={Boolean(diagnosticsProgress?.running)} onClick={() => runDoctor(true)}><Icon name="shield" size={17} /> Run and login test</button></div>{doctorRows.length > 0 ? <ul className="checks">{doctorRows.map((row, index) => <li key={`${row.message}-${index}`} className={`check check-${row.status}`}><span className="check-dot"><Icon name={row.status === 'pass' ? 'check' : row.status === 'warn' ? 'warning' : 'x'} size={13} /></span><span className="check-msg">{row.message}</span>{row.required === false && <span className="check-optional">optional</span>}</li>)}</ul> : <p className="empty-inline">No checks run yet.</p>}</div>}

          {settingsSection === 'updates' && <div className="panel settings-panel" data-testid="updates-panel"><div className="surface-intro"><div><h2>Application updates</h2><p>Keep the desktop app current without interrupting a download.</p></div><span className="state-badge state-neutral">v{version || '...'}</span></div><div className="update-summary"><div><span>Status</span><strong>{String(updateState.status || 'idle')}</strong></div>{updateState.version != null && <div><span>Available</span><strong>{String(updateState.version)}</strong></div>}</div>{updateState.message != null && <p className="inline-message">{String(updateState.message)}</p>}{updateState.status === 'downloading' && <ProgressBar label="Downloading update" value={Number(updateState.percent || 0)} detail={`${Number(updateState.percent || 0).toFixed(0)}%`} />}<label className="toggle-row"><input type="checkbox" checked={config.autoCheckUpdates} onChange={event => setConfig(previous => ({ ...previous, autoCheckUpdates: event.target.checked }))} /><span><strong>Check automatically</strong><small>Look for updates when the app starts.</small></span></label><div className="btn-row"><button className="btn-primary" disabled={updateState.status === 'checking' || updateState.status === 'downloading'} onClick={checkUpdates}><Icon name="refresh" size={17} /> Check now</button><button className="btn-secondary" onClick={() => saveSettings(false)}><Icon name="check" size={17} /> Save preferences</button>{updateState.status === 'available' && <button className="btn-secondary" onClick={downloadAppUpdate}><Icon name="download" size={17} /> Download update</button>}{updateState.status === 'ready' && <button className="btn-secondary" onClick={() => window.blackboxGui.installUpdate()}><Icon name="updates" size={17} /> Restart and install</button>}</div></div>}
        </section>}

        {activeView === 'agent' && <section className="view" data-testid="agent-panel"><div className="panel agent-panel"><div className="surface-intro"><div><h2>Read-only course context</h2><p>Export instructions, assignments, announcements, and attachments for coding agents. The export never submits work or changes Blackboard.</p></div><span className={`state-badge ${agentInfo?.configured ? 'state-good' : 'state-warn'}`}>{agentInfo?.configured ? 'Configured' : 'Setup needed'}</span></div><div className="agent-summary"><div><span>Workflow</span><strong>{agentInfo?.busy ? 'Busy' : 'Idle'}</strong></div><div><span>Export folder</span><strong className="mono">{String(agentInfo?.downloadDir || paths.downloads || config.downloadDir)}</strong></div></div><div className="agent-actions"><button className="btn-primary" onClick={syncAgent} disabled={Boolean(agentInfo?.busy) || !agentInfo?.configured}><Icon name="cloud-download" size={17} /> Build export</button><button className="btn-secondary" onClick={loadAgentStatus}><Icon name="refresh" size={17} /> Refresh status</button></div><div className="integration-row"><div><strong>Codex skill</strong><p>Install the local read-only skill in <code>~/.agents/skills</code>. Codex will discover it automatically; restart Codex if needed.</p>{skillPath && <span className="mono">{skillPath}</span>}</div><div className="integration-actions"><span className={`state-badge ${codexInstalled ? 'state-good' : 'state-neutral'}`}>{codexInstalled ? 'Installed' : 'Not installed'}</span>{codexInstalled ? <button className="btn-danger" onClick={removeCodex}><Icon name="x" size={16} /> Remove from Codex</button> : <button className="btn-secondary" onClick={installCodex}><Icon name="check" size={16} /> Install in Codex</button>}</div></div>{agentOutput && <div className="code-block"><pre>{JSON.stringify(agentOutput, null, 2)}</pre></div>}<p className="field-help">MCP command: <code>Blackbox.exe --mcp</code> when using the packaged app.</p></div></section>}

        {activeView === 'download' && (stage === 'courses' || stage === 'files' || stage === 'download' || stage === 'summary') && <section className="view download-view"><Stepper current={wizardStepIndex(stage)} />
          {stage === 'courses' && <div className="panel selection-panel" data-testid="course-list-panel"><div className="selection-head"><div><h2>Choose courses</h2><p>Select the courses to scan for files.</p></div><CountSummary items={[`${visibleCourses.length} shown`, `${selectedCourseIds.size} selected`, `${courses.length} total`]} /></div>{isScanningCourses && discoveryProgress && <ProgressBar label={discoveryProgress.phase === 'metadata' ? 'Reading file details' : 'Scanning course content'} value={discoveryPercent} detail={`${discoveryProgress.completed} / ${discoveryProgress.total}`} subdetail={discoveryProgress.currentSection || discoveryProgress.currentCourse || 'Working through the selected courses'} dataTestId="discovery-progress" />}<div className="toolbar"><label className="search-field"><Icon name="search" size={16} /><input className="search" placeholder="Filter courses" value={courseSearch} onChange={event => setCourseSearch(event.target.value)} /></label><div className="btn-row btn-row-inline"><button className="btn-secondary" disabled={isScanningCourses} onClick={() => setSelectedCourseIds(new Set(courses.map(course => course.id)))}><Icon name="check-square" size={16} /> Select all</button><button className="btn-ghost" disabled={isScanningCourses} onClick={() => setSelectedCourseIds(new Set())}><Icon name="x" size={16} /> Clear</button><button className="btn-primary" disabled={selectedCourses.length === 0 || isScanningCourses} onClick={runScanFiles}><Icon name="scan" size={16} className={isScanningCourses ? 'is-spinning' : ''} /> {isScanningCourses ? 'Scanning...' : 'Scan selected'}</button></div></div><div className="list" aria-busy={isScanningCourses}>{visibleCourses.map((course, index) => { const selected = selectedCourseIds.has(course.id); return <label key={course.id} className={`list-row ${selected ? 'is-selected' : ''}`} title={course.name}><input type="checkbox" checked={selected} disabled={isScanningCourses} onChange={event => setSelectedCourseIds(previous => { const next = new Set(previous); if (event.target.checked) next.add(course.id); else next.delete(course.id); return next; })} /><span className="list-index">{String(index + 1).padStart(2, '0')}</span><span className="list-name">{course.name}</span><span className={`list-state ${selected ? 'is-on' : ''}`}>{selected ? 'Selected' : 'Skipped'}</span></label>; })}{visibleCourses.length === 0 && <div className="empty-state"><Icon name="search-x" size={23} /><strong>No courses found</strong><span>{courses.length ? 'Try a different search.' : 'Start a download to discover courses.'}</span></div>}</div></div>}

          {stage === 'files' && (
            <div className="panel selection-panel" data-testid="file-list-panel">
              <div className="selection-head"><div><h2>Choose files</h2><p>Review files and choose which courses also include instructional text.</p></div><CountSummary items={[`${selectableFiles.length} shown`, `${selectedFileUrls.size} selected`, `${files.length} total`]} /></div>
              <CourseInstructionPicker courses={selectedCourses} selectedIds={selectedInstructionCourseIds} onToggle={courseId => setSelectedInstructionCourseIds(previous => { const next = new Set(previous); if (next.has(courseId)) next.delete(courseId); else next.add(courseId); return next; })} onSelectAll={() => setSelectedInstructionCourseIds(new Set(selectedCourses.map(course => course.id)))} onClear={() => setSelectedInstructionCourseIds(new Set())} />
              <div className="toolbar"><label className="search-field"><Icon name="search" size={16} /><input className="search" placeholder="Filter files" value={fileSearch} onChange={event => setFileSearch(event.target.value)} /></label><select value={typeFilter} onChange={event => setTypeFilter(event.target.value)}><option value="all">All types</option>{fileTypes.map(type => <option key={type} value={type}>{type.toUpperCase()}</option>)}</select><div className="btn-row btn-row-inline"><button className="btn-secondary" onClick={() => setSelectedFileUrls(new Set(files.map(file => file.url)))}><Icon name="check-square" size={16} /> Select all files</button><button className="btn-ghost" onClick={() => setSelectedFileUrls(new Set())}><Icon name="x" size={16} /> Clear files</button><button className="btn-primary" data-testid="download-selected" disabled={selectedFiles.length === 0 && selectedInstructionCourses.length === 0} onClick={startDownload}><Icon name="download" size={16} /> {selectedFiles.length > 0 && selectedInstructionCourses.length > 0 ? `Download ${selectedFiles.length} + text` : selectedFiles.length > 0 ? `Download ${selectedFiles.length}` : 'Download instructions'}</button></div></div>
              <div className="table"><div className="table-head"><span /><span>Name</span><span>Type</span><span>Size</span><span>Course / section</span><span>State</span></div>{selectableFiles.map(file => { const selected = selectedFileUrls.has(file.url); return <div className={`table-row selectable ${selected ? 'is-on' : ''}`} key={file.url} role="checkbox" aria-checked={selected} tabIndex={0} onClick={() => toggleFileSelection(file.url)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleFileSelection(file.url); } }}><span><input type="checkbox" checked={selected} onClick={event => event.stopPropagation()} onChange={() => toggleFileSelection(file.url)} /></span><span className="file-name"><Icon name="file" size={15} /><span className="ellipsis">{file.name}</span></span><span>{(file.fileType || '?').toUpperCase()}</span><span>{file.size ? formatBytes(file.size) : '?'}</span><span className="ellipsis">{file.courseName} / {file.sectionName}</span><span className={`tag ${selected ? 'tag-on' : 'tag-off'}`}>{selected ? 'Selected' : 'Ignored'}</span></div>; })}{selectableFiles.length === 0 && <div className="empty-state"><Icon name="search-x" size={23} /><strong>No files found</strong><span>{files.length ? 'Try a different search or type.' : 'Scan selected courses to find files.'}</span></div>}</div>
            </div>
          )}

          {stage === 'download' && (
            <div className="panel transfer-panel" data-testid="transfer-panel">
              <div className="transfer-head"><div><span className="transfer-status"><span className="live-dot" /> Live transfer</span><h2>{selectedRunFileCount > 0 ? 'Downloading selected content' : 'Saving course instructions'}</h2><p>{selectedRunFileCount > 0 ? 'Files and course text are being saved to your chosen folder.' : 'Every readable item in the included courses is being saved as Markdown.'}</p></div><div className="transfer-queue"><div className="queue-stat"><strong>{selectedRunFileCount}</strong><span>files queued</span></div>{selectedRunInstructionCourseCount > 0 && <div className="queue-stat queue-stat-instructions"><strong>{selectedRunInstructionCourseCount}</strong><span>courses with text</span></div>}</div></div>
              {selectedRunInstructionCourseCount > 0 && instructionProgress && <ProgressBar label={instructionProgress.phase === 'write' ? 'Saving course instructions' : 'Reading course instructions'} value={instructionPercent} detail={instructionProgress.phase === 'write' ? `${instructionProgress.completed} / ${instructionProgress.total} saved` : `${instructionProgress.itemsFound || 0} items found`} subdetail={instructionProgress.currentTitle || instructionProgress.currentSection || instructionProgress.currentCourse || 'Reading every selected course'} dataTestId="instruction-progress" />}
              {selectedRunFileCount > 0 ? <><ProgressBar label="Overall file progress" value={progressPercent} detail={downloadState.totalKnownBytes > 0 ? `${formatBytes(downloadState.downloadedBytes)} / ${formatBytes(downloadState.totalKnownBytes)}` : `${countProgress} / ${selectedRunFileCount} files`} subdetail={downloadState.failed ? `${downloadState.failed} failed` : 'Transfer in progress'} dataTestId="transfer-progress" /><div className="progress-readout"><strong>{progressPercent.toFixed(1)}%</strong><span>{downloadState.speed > 0 ? `${formatBytes(downloadState.speed)}/s` : 'Calculating speed...'}</span></div><div className="download-stats"><div className="download-stat"><span className="download-stat-icon"><Icon name="gauge" size={17} /></span><span><small>Speed</small><strong>{downloadState.speed > 0 ? `${formatBytes(downloadState.speed)}/s` : '?'}</strong></span></div><div className="download-stat"><span className="download-stat-icon"><Icon name="clock" size={17} /></span><span><small>Estimated time</small><strong>{downloadState.speed > 0 && downloadState.totalKnownBytes > 0 ? eta(remainingKnownBytes / downloadState.speed) : '?'}</strong></span></div><div className="download-stat"><span className="download-stat-icon"><Icon name="file" size={17} /></span><span><small>Unknown size</small><strong>{downloadState.unknownCount}</strong></span></div></div><div className="current-file"><span className="current-file-icon"><Icon name="file" size={17} /></span><span className="current-file-label">Currently saving</span><span className="download-wave" aria-hidden="true"><i /><i /><i /><i /></span><strong className="current-file-name">{downloadState.currentFile || 'Waiting for the first file...'}</strong></div><div className="tallies"><span className="tally tally-ok"><Icon name="check-circle" size={14} /> {downloadState.completed} done</span><span className="tally tally-skip"><Icon name="clock" size={14} /> {downloadState.skipped} skipped</span><span className="tally tally-fail"><Icon name="x-circle" size={14} /> {downloadState.failed} failed</span></div></> : <div className="instruction-only-note"><span className="download-stat-icon"><Icon name="book" size={17} /></span><span><strong>No file attachments selected</strong><small>The course instructions continue independently and will be saved as Markdown.</small></span></div>}
              <div className="btn-row download-footer"><button className="btn-ghost" onClick={openDownloads}><Icon name="folder" size={16} /> Open downloads</button><button className="btn-ghost" onClick={openLogs}><Icon name="terminal" size={16} /> Open logs</button></div>
            </div>
          )}

          {stage === 'summary' && summary && <div className="panel summary-panel"><div className="surface-intro"><div><h2>Download complete</h2><p>Files and course instructions were saved in this read-only run.</p></div><span className="state-badge state-good">Finished</span></div><div className="summary-grid"><div><span>Courses scanned</span><strong>{summary.coursesSelected}</strong></div><div><span>Files found</span><strong>{summary.filesDiscovered}</strong></div><div><span>Downloaded</span><strong className="text-good">{summary.filesDownloaded}</strong></div><div><span>Skipped</span><strong className="text-warn">{summary.filesSkipped}</strong></div><div><span>Failed</span><strong className="text-bad">{summary.filesFailed}</strong></div><div><span>Instruction courses</span><strong>{summary.instructionCoursesSelected}</strong></div><div><span>Instructions saved</span><strong className="text-good">{summary.instructionsDownloaded}</strong></div><div><span>Text discovered</span><strong>{summary.instructionsDiscovered}</strong></div></div>{summary.failedFiles.length > 0 && <ul className="checks">{summary.failedFiles.map(file => <li key={`${file.name}-${file.reason}`} className="check check-fail"><span className="check-dot"><Icon name="x" size={13} /></span><span className="check-msg">{file.name}: {file.reason}</span></li>)}</ul>}{summary.instructionWarnings.length > 0 && <ul className="checks">{summary.instructionWarnings.map(warning => <li key={warning} className="check check-warn"><span className="check-dot"><Icon name="warning" size={13} /></span><span className="check-msg">{warning}</span></li>)}</ul>}<div className="btn-row"><button className="btn-primary" onClick={beginDownload}><Icon name="refresh" size={16} /> Run again</button><button className="btn-ghost" onClick={openDownloads}><Icon name="folder" size={16} /> Open downloads</button><button className="btn-ghost" onClick={openLogs}><Icon name="terminal" size={16} /> Open logs</button></div></div>}
        </section>}
      </main>
    </div>
  );
}

function CourseInstructionPicker({
  courses,
  selectedIds,
  onToggle,
  onSelectAll,
  onClear,
}: {
  courses: Course[];
  selectedIds: Set<string>;
  onToggle: (courseId: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  return <section className="instruction-picker" data-testid="instruction-picker">
    <div className="instruction-picker-head">
      <div><span className="instruction-eyebrow"><Icon name="book" size={14} /> Course-level text</span><h3>Include instructions and text</h3><p>Save every readable instruction, assignment, announcement, and text item for the included courses. Individual items are included automatically.</p></div>
      <CountSummary items={[`${selectedIds.size} included`, `${courses.length} courses`]} />
    </div>
    <div className="instruction-course-list">
      {courses.map(course => {
        const selected = selectedIds.has(course.id);
        return <label key={course.id} className={`instruction-course-row ${selected ? 'is-selected' : ''}`} title={course.name}>
          <input type="checkbox" data-testid={`instruction-course-${course.id}`} checked={selected} onChange={() => onToggle(course.id)} />
          <span className="instruction-course-icon"><Icon name="book" size={16} /></span>
          <span className="instruction-course-copy"><strong className="ellipsis">{course.name}</strong><small>All readable course content</small></span>
          <span className={`instruction-course-state ${selected ? 'is-on' : ''}`}>{selected ? 'Included' : 'Skipped'}</span>
        </label>;
      })}
      {courses.length === 0 && <div className="empty-inline">Select at least one course to include its instructions.</div>}
    </div>
    <div className="instruction-picker-footer"><span>{selectedIds.size > 0 ? `${selectedIds.size} course${selectedIds.size === 1 ? '' : 's'} will be scraped completely.` : 'No course instructions selected.'}</span><div className="btn-row btn-row-inline"><button className="btn-ghost btn-compact" onClick={onSelectAll} disabled={courses.length === 0}>Include all</button><button className="btn-ghost btn-compact" onClick={onClear} disabled={selectedIds.size === 0}>Clear</button></div></div>
  </section>;
}

function BrowserModeSlider({ headless, onChange }: { headless: boolean; onChange: (headless: boolean) => void }) {
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(headless ? 0 : 100);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = sliderRef.current;
    if (!element) return;
    const updateWidth = () => setWidth(element.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!dragging) setPosition(headless ? 0 : 100);
  }, [dragging, headless]);

  const positionFromClientX = (clientX: number): number => {
    const rect = sliderRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return headless ? 0 : 100;
    return clampPercent(((clientX - rect.left) / rect.width) * 100);
  };

  const updateFromClientX = (clientX: number) => {
    const nextPosition = positionFromClientX(clientX);
    setPosition(nextPosition);
    onChange(nextPosition < 50);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    updateFromClientX(event.clientX);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragging) updateFromClientX(event.clientX);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const finalPosition = positionFromClientX(event.clientX);
    const finalHeadless = finalPosition < 50;
    onChange(finalHeadless);
    setDragging(false);
    setPosition(finalHeadless ? 0 : 100);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextHeadless: boolean | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'Home') nextHeadless = true;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'End') nextHeadless = false;
    if (nextHeadless === null) return;
    event.preventDefault();
    setPosition(nextHeadless ? 0 : 100);
    onChange(nextHeadless);
  };

  const sliderInset = 4;
  const thumbSize = 22;
  const thumbGap = 4;
  const segmentWidth = Math.max(0, (width - sliderInset * 2) / 2);
  const activeLeft = width > 0 ? sliderInset + (width / 2 - sliderInset) * (position / 100) : undefined;
  const thumbLeft = width > 0 ? (activeLeft || sliderInset) + segmentWidth - thumbSize - thumbGap : undefined;

  return <div className="browser-mode-control">
    <div ref={sliderRef} className="mode-slider" data-mode={headless ? 'headless' : 'visible'} data-dragging={dragging ? 'true' : 'false'} role="slider" tabIndex={0} aria-labelledby="browser-mode-label" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position)} aria-valuetext={headless ? 'Headless, default' : 'Visible browser'} aria-orientation="horizontal" onKeyDown={handleKeyDown} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={() => setDragging(false)}>
      <span className="mode-slider-track" aria-hidden="true"><span className="mode-slider-active" style={activeLeft === undefined ? undefined : { left: `${activeLeft}px`, width: `${segmentWidth}px` }} /><span className="mode-slider-thumb" style={thumbLeft === undefined ? undefined : { left: `${thumbLeft}px` }}><Icon name={headless ? 'monitor' : 'eye'} size={14} /></span></span>
      <span className={`mode-option mode-option-headless ${headless ? 'is-active' : ''}`}><Icon name="monitor" size={14} /><span>Headless <small>(default)</small></span></span>
      <span className={`mode-option mode-option-visible ${headless ? '' : 'is-active'}`}><Icon name="eye" size={14} /><span>Visible</span></span>
    </div>
    <div className="mode-caption"><span>{headless ? 'The browser stays hidden during a run.' : 'The browser window stays visible for troubleshooting.'}</span><strong>{headless ? 'Default' : 'Visible'}</strong></div>
  </div>;
}

function ProgressBar({ label, value, detail, subdetail, indeterminate = false, dataTestId }: { label: string; value: number; detail?: string; subdetail?: string; indeterminate?: boolean; dataTestId?: string }) {
  const percent = clampPercent(value);
  return <div className="progress-block" data-testid={dataTestId}><div className="progress-caption"><strong>{label}</strong><span className="mono">{detail || `${percent.toFixed(0)}%`}</span></div><div className={`progress-track ${indeterminate ? 'is-indeterminate' : ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} {...(!indeterminate ? { 'aria-valuenow': percent } : {})}><span className="progress-fill" style={indeterminate ? undefined : { transform: `scaleX(${percent / 100})` }} /></div>{subdetail && <div className="progress-subdetail">{subdetail}</div>}</div>;
}

function CountSummary({ items }: { items: string[] }) { return <div className="count-summary">{items.map(item => <span key={item}>{item}</span>)}</div>; }

function Stepper({ current }: { current: number }) {
  return <ol className="stepper" aria-label="Download progress">{WIZARD_STEPS.map((label, index) => { const state = index < current ? 'done' : index === current ? 'active' : 'todo'; return <li key={label} className={`step step-${state}`} aria-current={state === 'active' ? 'step' : undefined}><span className="step-dot">{index < current ? <Icon name="check" size={14} /> : index + 1}</span><span className="step-label">{label}</span>{index < WIZARD_STEPS.length - 1 && <span className="step-line" />}</li>; })}</ol>;
}
