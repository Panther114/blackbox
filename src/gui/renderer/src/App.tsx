import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, AppIcon } from "./components/Icons";
import { Action, Surface, Scene, WorkspaceNavigation, WorkspaceHeading, WorkspaceFooter } from "./components/Workspace";
import { DotWave, DotWaveSetting, readDotWaveMode, saveDotWaveMode } from "./components/DotWave";
import type { DotWaveMode } from "./components/waveEngine";
import { toGuiErrorMessage } from '../../errorMessage';
import {
  DEMO_AGENT_OUTPUT,
  DEMO_AGENT_STATUS,
  DEMO_COURSES,
  DEMO_DOCTOR_ROWS,
  DEMO_FILES,
  DEMO_SUMMARY,
} from './demoData';

type TransferSnapshot = {
  total: number; settled: number; completed: number; skipped: number; rejected: number; failed: number; cancelled: number; retrying: number;
  bytes: number; totalBytes: number; unknownSize: number; percent: number; basis: 'bytes' | 'files'; speed: number; etaSeconds: number | null; elapsedMs: number; active: string[];
};
type SortKey = 'default' | 'name' | 'type' | 'size' | 'course';
type DownloadStage = 'ready' | 'courses' | 'files' | 'download' | 'summary';
type View = 'download' | 'automation' | 'agent' | 'settings';
type SettingsSection = 'credentials' | 'courses' | 'diagnostics' | 'updates';
type AutomationTab = 'downloads' | 'settings';
type AutomationGnumberStatus = 'pending' | 'logging-in' | 'discovering' | 'downloading' | 'done' | 'failed' | 'cancelled';
type AutomationSettingsState = {
  gnumbers: string[];
  downloadDir: string;
  maxFileSizeMB: number;
  excludedExtensionsCsv: string;
};
type AutomationGnumberRun = {
  gnumber: string;
  status: AutomationGnumberStatus;
  error?: string;
  courses: string[];
  claimedCourses: string[];
  skippedCourses: string[];
  filesDownloaded: number;
  filesFailed: number;
  filesSkipped: number;
  instructionsDownloaded: number;
};
type AutomationRunView = {
  running: boolean;
  total: number;
  parallelSessions: number;
  entries: Record<string, AutomationGnumberRun>;
  failedLogins: Array<{ gnumber: string; error: string; at: string }>;
  uniqueCourses: number;
  filesDownloaded: number;
  filesFailed: number;
  filesSkipped: number;
  instructionsDownloaded: number;
  summary?: {
    succeeded: number;
    runlogPath: string;
    xlsxPath: string;
    debugPath: string;
    cancelled?: boolean;
  };
  error?: string;
};
type Course = { id: string; name: string; url: string; path: string };
type BlockedCourse = { id: string; name: string };
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
/** Which layouts already hold a copy of a discovered file. */
type ExistingFileState = { hierarchy: boolean; flat: boolean; size?: number };
type Summary = {
  downloadDir?: string;
  durationMs?: number;
  coursesDiscovered: number;
  coursesSelected: number;
  filesDiscovered: number;
  filesSelected: number;
  filesDownloaded: number;
  filesSkipped: number;
  /** Files the chosen layout already held before this run started. */
  alreadySaved?: number;
  filesRejected?: number;
  filesFailed: number;
  failedFiles: Array<{ name: string; reason: string }>;
  instructionCoursesSelected: number;
  instructionsDiscovered: number;
  instructionsDownloaded: number;
  instructionWarnings: string[];
  /** True when the user stopped the run before it completed on its own. */
  cancelled?: boolean;
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

const DEMO_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';
const DEMO_SCREEN = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('screen') : null;

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

const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};
const clampPercent = (value: number): number => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function parseGnumberList(input: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\r\n,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const digits = token.replace(/^G/i, '').replace(/[^\d]/g, '');
    if (!/^\d{6,10}$/.test(digits)) { invalid.push(token); continue; }
    const normalized = 'G' + digits;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    valid.push(normalized);
  }
  return { valid, invalid };
}

function applyAutomationEvent(
  previous: AutomationRunView | null,
  type: string,
  payload: Record<string, unknown>,
): AutomationRunView | null {
  if (!previous) {
    if (type === 'automation:start') {
      return {
        running: true,
        total: Number(payload.total || 0),
        parallelSessions: Number(payload.parallelSessions || 1),
        entries: {},
        failedLogins: [],
        uniqueCourses: 0,
        filesDownloaded: 0,
        filesFailed: 0,
        filesSkipped: 0,
        instructionsDownloaded: 0,
      };
    }
    return previous;
  }

  const next: AutomationRunView = { ...previous, entries: { ...previous.entries } };
  const ensureEntry = (gnumber: string): AutomationGnumberRun => {
    const existing = next.entries[gnumber];
    if (existing) return existing;
    const created: AutomationGnumberRun = {
      gnumber,
      status: 'pending',
      courses: [],
      claimedCourses: [],
      skippedCourses: [],
      filesDownloaded: 0,
      filesFailed: 0,
      filesSkipped: 0,
      instructionsDownloaded: 0,
    };
    next.entries[gnumber] = created;
    return created;
  };
  const patch = (gnumber: string, mutate: (entry: AutomationGnumberRun) => void): void => {
    const entry = ensureEntry(gnumber);
    const copy = { ...entry };
    mutate(copy);
    next.entries[gnumber] = copy;
  };

  switch (type) {
    case 'automation:gnumber:start':
      patch(String(payload.gnumber), entry => { entry.status = 'logging-in'; entry.error = undefined; });
      break;
    case 'automation:gnumber:status': {
      const status = String(payload.status) as AutomationGnumberStatus;
      patch(String(payload.gnumber), entry => { entry.status = status; entry.error = payload.error ? String(payload.error) : undefined; });
      break;
    }
    case 'automation:gnumber:courses':
      patch(String(payload.gnumber), entry => { entry.courses = Array.isArray(payload.courses) ? payload.courses.map(String) : []; });
      break;
    case 'automation:course:claimed':
      patch(String(payload.gnumber), entry => { entry.claimedCourses = [...entry.claimedCourses, String(payload.course)]; });
      next.uniqueCourses += 1;
      break;
    case 'automation:course:released':
      patch(String(payload.gnumber), entry => { entry.claimedCourses = entry.claimedCourses.filter(course => course !== String(payload.course)); });
      next.uniqueCourses = Math.max(0, next.uniqueCourses - 1);
      break;
    case 'automation:course:skipped':
      patch(String(payload.gnumber), entry => { entry.skippedCourses = [...entry.skippedCourses, String(payload.course)]; });
      break;
    case 'automation:file:done':
      patch(String(payload.gnumber), entry => { entry.filesDownloaded += 1; });
      next.filesDownloaded += 1;
      break;
    case 'automation:file:progress':
      break;
    case 'automation:course:done':
      break;
    case 'automation:gnumber:done': {
      const status = String(payload.status) as AutomationGnumberStatus;
      patch(String(payload.gnumber), entry => { entry.status = status; entry.error = payload.error ? String(payload.error) : undefined; });
      break;
    }
    case 'automation:done':
      next.running = false;
      break;
    case 'automation:cancelled':
      next.running = false;
      break;
    default:
      break;
  }
  return next;
}
const demoInstructionCount = (courseCount: number): number => courseCount > 0 ? Math.max(courseCount, Math.round((courseCount * 42) / 9)) : 0;
const WIZARD_STEPS = ['Courses', 'Files', 'Download', 'Summary'] as const;
const wizardStepIndex = (stage: DownloadStage): number => stage === 'courses' ? 0 : stage === 'files' ? 1 : stage === 'download' ? 2 : stage === 'summary' ? 3 : -1;
const SAVED_PASSWORD_MASK = '••••••••';

function harnessSkillInstalled(info: Record<string, unknown> | null): boolean {
  const nested = info?.harnessSkill;
  return Boolean(info?.harnessInstalled || (nested && typeof nested === 'object' && (nested as Record<string, unknown>).installed));
}

function harnessSkillPath(info: Record<string, unknown> | null): string {
  const nested = info?.harnessSkill;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).path === 'string') return String((nested as Record<string, unknown>).path);
  return typeof info?.harnessSkillPath === 'string' ? String(info.harnessSkillPath) : '';
}

export function App() {
  const [dotMode, setDotMode] = useState<DotWaveMode>(readDotWaveMode);
  const [stage, setStage] = useState<DownloadStage>('ready');
  const [activeView, setActiveView] = useState<View>('download');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('credentials');
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const abortedRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Errors are shown briefly; they stay in the log.
  useEffect(() => {
    if (!errorMessage) return undefined;
    const timer = window.setTimeout(() => setErrorMessage(''), 3000);
    return () => window.clearTimeout(timer);
  }, [errorMessage]);
  const [isPreparingDownload, setIsPreparingDownload] = useState(false);
  const [isCancellingDownload, setIsCancellingDownload] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [savedPassword, setSavedPassword] = useState('');
  const [passwordStored, setPasswordStored] = useState(false);
  const [passwordReadable, setPasswordReadable] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [hasCredentials, setHasCredentials] = useState(false);
  const [isScanningCourses, setIsScanningCourses] = useState(false);
  const [isScanningBlockedCourses, setIsScanningBlockedCourses] = useState(false);
  const [blockedCourseCatalog, setBlockedCourseCatalog] = useState<Course[]>([]);
  const [config, setConfig] = useState({ username: '', password: '', downloadDir: './downloads', headless: true, autoCheckUpdates: true, blockedCourses: [] as BlockedCourse[] });
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
  const [sortKey, setSortKey] = useState<SortKey>('default');
  const [sortDesc, setSortDesc] = useState(false);
  const [transfer, setTransfer] = useState<TransferSnapshot | null>(null);
  const [selectedFileUrls, setSelectedFileUrls] = useState<Set<string>>(new Set());
  /** Per-URL, per-layout "already saved" state from the last scan. */
  const [existingByUrl, setExistingByUrl] = useState<Record<string, ExistingFileState>>({});
  /** Show files the current layout already holds (marked, not selectable). */
  const [showSavedFiles, setShowSavedFiles] = useState(false);
  /** The course-text picker starts collapsed: the file list is the main task. */
  const [instructionPickerOpen, setInstructionPickerOpen] = useState(false);
  /** Keep the Blackboard course / section / folder structure, or drop files straight into the course folder. */
  const [keepHierarchy, setKeepHierarchy] = useState(true);
  const [knownByUrl, setKnownByUrl] = useState<Map<string, number>>(new Map());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [downloadState, setDownloadState] = useState({ completed: 0, failed: 0, skipped: 0, downloadedBytes: 0, totalKnownBytes: 0, unknownCount: 0, speed: 0, currentFile: '' });
  const [perUrlDownloaded, setPerUrlDownloaded] = useState<Map<string, number>>(new Map());
  const [selectedRunFileCount, setSelectedRunFileCount] = useState(0);
  /** Layout actually used by the current/last run, for the transfer and summary screens. */
  const [runLayout, setRunLayout] = useState<'hierarchy' | 'flat'>('hierarchy');
  const [selectedRunInstructionCourseCount, setSelectedRunInstructionCourseCount] = useState(0);
  const [instructionProgress, setInstructionProgress] = useState<InstructionProgress | null>(null);
  const [agentInfo, setAgentInfo] = useState<Record<string, unknown> | null>(null);
  const [agentOutput, setAgentOutput] = useState<Record<string, unknown> | null>(null);
  const [updateState, setUpdateState] = useState<Record<string, unknown>>({ status: 'idle' });
  const [automationTab, setAutomationTab] = useState<AutomationTab>('settings');
  const [automationSettings, setAutomationSettings] = useState<AutomationSettingsState>({
    gnumbers: [],
    downloadDir: '',
    maxFileSizeMB: 100,
    excludedExtensionsCsv: '.mp3, .mp4',
  });
  const [automationNormalDir, setAutomationNormalDir] = useState('');
  const [automationGnumberModal, setAutomationGnumberModal] = useState(false);
  const [automationGnumberDraft, setAutomationGnumberDraft] = useState('');
  const [automationRun, setAutomationRun] = useState<AutomationRunView | null>(null);
  const [isAutomationRunning, setIsAutomationRunning] = useState(false);

  // Notices vanish after a moment; only the status of work that is still running stays.
  const workInProgress = isPreparingDownload || isCancellingDownload || isScanningCourses || isScanningBlockedCourses || isAutomationRunning;
  useEffect(() => {
    if (!status || workInProgress) return undefined;
    const timer = window.setTimeout(() => setStatus(''), 3000);
    return () => window.clearTimeout(timer);
  }, [status, workInProgress]);

  const selectedRunUrlSetRef = useRef<Set<string>>(new Set());
  const selectedRunKnownByUrlRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (DEMO_MODE) {
      const demoDownloadDir = 'C:\\Users\\demo\\Downloads\\Blackbox';
      setVersion('2.0.1');
      setConfig(previous => ({ ...previous, username: 'g12345678', password: 'blackboard-demo-password', downloadDir: demoDownloadDir, headless: true, autoCheckUpdates: true }));
      setSavedPassword('blackboard-demo-password');
      setPasswordStored(true);
      setPasswordReadable(true);
      setPasswordError('');
      setHasCredentials(true);
      setBlockedCourseCatalog(DEMO_COURSES);
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
        const demoExisting = demoExistingState(DEMO_FILES);
        setCourses(DEMO_COURSES); setSelectedCourseIds(new Set(DEMO_COURSES.slice(0, 9).map(course => course.id))); setSelectedInstructionCourseIds(new Set(DEMO_COURSES.slice(0, 9).map(course => course.id))); setFiles(DEMO_FILES); setExistingByUrl(demoExisting); setSelectedFileUrls(new Set(DEMO_FILES.filter(file => !demoExisting[file.url]?.hierarchy).map(file => file.url))); setStage('files');
      } else if (DEMO_SCREEN === 'download') {
        const totalKnownBytes = DEMO_FILES.reduce((total, file) => total + (file.size || 0), 0);
        setFiles(DEMO_FILES); setSelectedFileUrls(new Set(DEMO_FILES.map(file => file.url))); setSelectedInstructionCourseIds(new Set(DEMO_COURSES.slice(0, 9).map(course => course.id))); setSelectedRunFileCount(DEMO_FILES.length); setSelectedRunInstructionCourseCount(9); setInstructionProgress({ phase: 'write', completed: 24, total: demoInstructionCount(9), currentCourse: DEMO_COURSES[5].name, currentSection: 'Course Materials', currentTitle: 'Midterm study guide and assessment criteria' });
        setDownloadState({ completed: 31, failed: 1, skipped: 4, downloadedBytes: Math.round(totalKnownBytes * 0.48), totalKnownBytes, unknownCount: 0, speed: 1_820_000, currentFile: DEMO_FILES[35].name }); setStage('download');
      } else if (DEMO_SCREEN === 'summary') {
        setSummary(DEMO_SUMMARY); setStage('summary');
      } else if (DEMO_SCREEN === 'diagnostics') {
        setActiveView('settings'); setSettingsSection('diagnostics'); setDoctorRows(DEMO_DOCTOR_ROWS); setDiagnosticsProgress({ running: false, completed: 10, total: 10, current: 'Diagnostics complete', loginTest: false });
      } else if (DEMO_SCREEN === 'blocked-courses' || DEMO_SCREEN === 'course-settings') {
        setActiveView('settings'); setSettingsSection('courses');
      } else if (DEMO_SCREEN === 'automation') setActiveView('automation');
      else if (DEMO_SCREEN === 'agent') setActiveView('agent');
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
        const loadedBlockedCourses = Array.isArray(cfg.blockedCourses)
          ? cfg.blockedCourses
              .filter(
                (course): course is BlockedCourse =>
                  Boolean(course) &&
                  typeof course === 'object' &&
                  typeof (course as Record<string, unknown>).id === 'string' &&
                  typeof (course as Record<string, unknown>).name === 'string',
              )
              .map(course => ({ id: course.id.trim(), name: course.name.trim() }))
              .filter(course => Boolean(course.id && course.name))
          : [];
        setConfig(previous => ({ ...previous, blockedCourses: loadedBlockedCourses }));
        setPaths(await window.blackboxGui.getPaths());
        setUpdateState(await window.blackboxGui.getUpdateState());
        try {
          const automation = (await window.blackboxGui.loadAutomationSettings()) as { settings: Record<string, unknown>; normalDownloadDir: string };
          const stored = automation.settings as Record<string, unknown>;
          setAutomationSettings({
            gnumbers: Array.isArray(stored.gnumbers) ? (stored.gnumbers as string[]).map(String) : [],
            downloadDir: String(stored.downloadDir || ''),
            maxFileSizeMB: Math.max(1, Math.round(Number(stored.maxFileSizeBytes || 0) / (1024 * 1024)) || 100),
            excludedExtensionsCsv: Array.isArray(stored.excludedExtensions) ? (stored.excludedExtensions as string[]).map(String).join(', ') : '.mp3, .mp4',
          });
          setAutomationNormalDir(String(automation.normalDownloadDir || ''));
        } catch { /* the automation panel surfaces validation errors on save */ }
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
      if (evt.type === 'transfer:progress') {
        // The backend owns the numbers: counts, bytes, speed and ETA arrive as one snapshot.
        const snapshot = evt.payload as TransferSnapshot;
        setTransfer(snapshot);
        setDownloadState({ completed: snapshot.completed, failed: snapshot.failed, skipped: snapshot.skipped + snapshot.rejected, downloadedBytes: snapshot.bytes, totalKnownBytes: snapshot.totalBytes, unknownCount: snapshot.unknownSize, speed: snapshot.speed, currentFile: snapshot.active[0] || '' });
      }
      if (evt.type === 'download:cancel') { setIsCancellingDownload(true); setStatus('Stopping the download. Files already saved are kept.'); }
      if (evt.type === 'diagnostics:progress') setDiagnosticsProgress({ running: Boolean(payload.running), completed: Number(payload.completed || 0), total: Number(payload.total || 0), current: String(payload.current || ''), loginTest: Boolean(payload.loginTest) });
      if (evt.type === 'summary:ready') setSummary(evt.payload as Summary);
      if (evt.type === 'update:state') setUpdateState(evt.payload as Record<string, unknown>);
      if (evt.type.startsWith('automation:')) setAutomationRun(previous => applyAutomationEvent(previous, evt.type, payload));
    });
    return () => unsub();
  }, [selectedCourseIds.size]);

  useEffect(() => { if (activeView !== 'settings' || settingsSection !== 'credentials') setShowPassword(false); }, [activeView, settingsSection]);

  const deferredCourseSearch = useDeferredValue(courseSearch);
  const deferredFileSearch = useDeferredValue(fileSearch);
  const blockedCourseIds = useMemo(() => new Set(config.blockedCourses.map(course => course.id)), [config.blockedCourses]);
  const visibleCourses = useMemo(
    () => courses.filter(
      course =>
        !blockedCourseIds.has(course.id) &&
        course.name.toLowerCase().includes(deferredCourseSearch.toLowerCase()),
    ),
    [blockedCourseIds, courses, deferredCourseSearch],
  );
  // "Already saved" is tracked per layout: a folder-structure download does not
  // mark a file as saved for a flat run (and the other way round), so switching
  // the layout instantly re-marks the list from the same scan.
  const layoutKey: 'hierarchy' | 'flat' = keepHierarchy ? 'hierarchy' : 'flat';
  const savedInLayout = useCallback(
    (url: string) => Boolean(existingByUrl[url]?.[layoutKey]),
    [existingByUrl, layoutKey],
  );
  const savedFileCount = useMemo(
    () => files.filter(file => savedInLayout(file.url)).length,
    [files, savedInLayout],
  );
  const selectableFiles = useMemo(() => files.filter(file => {
    const query = `${file.name} ${file.courseName} ${file.sectionName}`.toLowerCase();
    if (deferredFileSearch && !query.includes(deferredFileSearch.toLowerCase())) return false;
    if (typeFilter !== 'all' && fileKind(file).toLowerCase() !== typeFilter) return false;
    if (savedInLayout(file.url) && !showSavedFiles) return false;
    return true;
  }), [files, deferredFileSearch, typeFilter, savedInLayout, showSavedFiles]);
  const sortedFiles = useMemo(() => {
    if (sortKey === 'default') return selectableFiles;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const byName = (a: DiscoveredFile, b: DiscoveredFile) => collator.compare(a.name, b.name);
    const compare = (a: DiscoveredFile, b: DiscoveredFile): number => {
      if (sortKey === 'name') return byName(a, b);
      if (sortKey === 'type') return collator.compare(fileKind(a), fileKind(b)) || byName(a, b);
      if (sortKey === 'course') return collator.compare(`${a.courseName} ${a.sectionName}`, `${b.courseName} ${b.sectionName}`) || byName(a, b);
      // Size: files with an unknown size always sort last, whichever direction is chosen.
      const unknownA = typeof a.size !== 'number';
      const unknownB = typeof b.size !== 'number';
      if (unknownA || unknownB) return unknownA === unknownB ? byName(a, b) : unknownA ? 1 : -1;
      return (a.size as number) - (b.size as number) || byName(a, b);
    };
    const sorted = [...selectableFiles].sort(compare);
    if (!sortDesc) return sorted;
    return sortKey === 'size' ? [...sorted.filter(file => typeof file.size === 'number').reverse(), ...sorted.filter(file => typeof file.size !== 'number')] : sorted.reverse();
  }, [selectableFiles, sortKey, sortDesc]);
  function toggleSort(key: Exclude<SortKey, 'default'>) {
    if (sortKey !== key) { setSortKey(key); setSortDesc(key === 'size'); return; }
    if (sortDesc === (key === 'size')) { setSortDesc(previous => !previous); return; }
    setSortKey('default'); setSortDesc(false);
  }
  const pendingFiles = useMemo(
    () => files.filter(file => !savedInLayout(file.url)),
    [files, savedInLayout],
  );
  const selectedCourses = courses.filter(course => selectedCourseIds.has(course.id) && !blockedCourseIds.has(course.id));
  const selectedInstructionCourses = selectedCourses.filter(course => selectedInstructionCourseIds.has(course.id));
  const selectedFiles = files.filter(file => selectedFileUrls.has(file.url) && !savedInLayout(file.url));
  const blockedCourseRows = useMemo(() => {
    const knownIds = new Set(blockedCourseCatalog.map(course => course.id));
    const missing = config.blockedCourses
      .filter(course => !knownIds.has(course.id))
      .map(course => ({ id: course.id, name: course.name, url: '', path: '' }));
    return [...blockedCourseCatalog, ...missing];
  }, [blockedCourseCatalog, config.blockedCourses]);
  const progressPercent = transfer ? transfer.percent : downloadState.totalKnownBytes > 0 ? clampPercent((downloadState.downloadedBytes / downloadState.totalKnownBytes) * 100) : selectedRunFileCount > 0 ? clampPercent(((downloadState.completed + downloadState.skipped) / selectedRunFileCount) * 100) : 0;
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
    // A file the current layout already holds stays out of the selection.
    if (savedInLayout(url)) return;
    setSelectedFileUrls(previous => { const next = new Set(previous); if (next.has(url)) next.delete(url); else next.add(url); return next; });
  }

  async function runWithUiError(action: () => Promise<void>): Promise<void> {
    setErrorMessage('');
    try { await action(); } catch (error) { setStatus(''); if (!abortedRef.current) setErrorMessage(toGuiErrorMessage(error)); }
  }

  async function openDownloads() {
    if (DEMO_MODE || !window.blackboxGui) { setStatus('Offline demo: the download directory is represented without opening a folder.'); return; }
    const error = await window.blackboxGui.openDownloads(); if (error) setErrorMessage(error);
  }

  /**
   * Switch the download folder layout. "Already saved" is tracked per layout, so
   * the list re-marks itself and the selection follows the new layout: every file
   * that layout still needs is selected, and nothing already saved is.
   */
  function chooseLayout(next: 'hierarchy' | 'flat') {
    setKeepHierarchy(next === 'hierarchy');
    setShowSavedFiles(false);
    const savedInNext = (url: string) => Boolean(existingByUrl[url]?.[next]);
    setSelectedFileUrls(new Set(files.filter(file => !savedInNext(file.url)).map(file => file.url)));
  }

  async function openLogs() {
    if (DEMO_MODE || !window.blackboxGui) { setStatus('Offline demo: logs are represented without opening a folder.'); return; }
    const error = await window.blackboxGui.openLogs(); if (error) setErrorMessage(error);
  }

  async function chooseDownloadDirectory() {
    if (DEMO_MODE || !window.blackboxGui) { setConfig(previous => ({ ...previous, downloadDir: 'C:\\Users\\demo\\Documents\\Blackbox' })); setStatus('Folder selected. Save settings to keep it.'); return; }
    await runWithUiError(async () => { const selected = await window.blackboxGui.chooseDownloadDirectory(); if (selected) { setConfig(previous => ({ ...previous, downloadDir: selected })); setStatus('Folder selected. Save settings to keep it.'); } });
  }

  function clearDownloads() {
    setConfirmClear(true);
  }

  async function performClearDownloads() {
    setConfirmClear(false);
    await runWithUiError(async () => {
      setStatus('Clearing downloaded files...');
      let removed = 0;
      if (DEMO_MODE || !window.blackboxGui) {
        await delay(300);
      } else {
        const result = await window.blackboxGui.clearDownloads({ downloadDir: config.downloadDir });
        removed = Number(result.removed || 0);
      }
      setCourses([]);
      setSelectedCourseIds(new Set());
      setSelectedInstructionCourseIds(new Set());
      setFiles([]);
      setSelectedFileUrls(new Set());
      setKnownByUrl(new Map());
      setSummary(null);
      setDiscoveryProgress(null);
      setInstructionProgress(null);
      setStage('ready');
      setStatus(
        removed === 1
          ? 'Cleared 1 item from the download directory.'
          : 'Cleared ' + removed + ' items from the download directory.',
      );
    });
  }

  async function scanBlockedCourses() {
    if (isScanningBlockedCourses) return;
    setActiveView('settings');
    setSettingsSection('courses');
    setIsScanningBlockedCourses(true);
    await runWithUiError(async () => {
      const hasPassword = passwordStored && config.password === SAVED_PASSWORD_MASK
        ? true
        : Boolean(config.password.trim());
      if (!config.username.trim() || !hasPassword) {
        throw new Error('Save your Blackboard username and password in Credentials before scanning courses.');
      }
      setStatus(DEMO_MODE ? 'Scanning the offline course catalog...' : 'Scanning your Blackboard course list...');
      const discovered = DEMO_MODE || !window.blackboxGui
        ? (await delay(450), DEMO_COURSES)
        : await window.blackboxGui.scanCourses({
            username: config.username || undefined,
            password: passwordStored && config.password === SAVED_PASSWORD_MASK ? undefined : config.password || undefined,
            downloadDir: config.downloadDir,
            headless: config.headless,
          });
      setBlockedCourseCatalog(discovered);
      setStatus(
        discovered.length === 1
          ? 'Found 1 course. Select the courses to block, then save.'
          : 'Found ' + discovered.length + ' courses. Select the courses to block, then save.',
      );
    });
    setIsScanningBlockedCourses(false);
  }

  function toggleBlockedCourse(course: Course) {
    const isBlocked = config.blockedCourses.some(blocked => blocked.id === course.id);
    const blockedCourses = isBlocked
      ? config.blockedCourses.filter(blocked => blocked.id !== course.id)
      : [...config.blockedCourses, { id: course.id, name: course.name }];
    setConfig(previous => ({ ...previous, blockedCourses }));
    if (!isBlocked) {
      setSelectedCourseIds(previous => {
        const next = new Set(previous);
        next.delete(course.id);
        return next;
      });
      setSelectedInstructionCourseIds(previous => {
        const next = new Set(previous);
        next.delete(course.id);
        return next;
      });
    }
    setStatus('Course block changes are pending. Save settings to apply them.');
  }

  async function runDemoPreparation() {
    setIsPreparingDownload(true); setStage('ready'); setSummary(null); setInstructionProgress(null); setSelectedRunInstructionCourseCount(0); setPreparationProgress({ completed: 0, total: 3, label: 'Connecting to Blackboard (offline demo)' }); setStatus('Simulating a Blackboard session. No network request will be made.');
    await delay(650); setPreparationProgress({ completed: 1, total: 3, label: 'Loading your course list' }); await delay(550); setPreparationProgress({ completed: 2, total: 3, label: 'Indexing available courses' }); await delay(750);
    const availableDemoCourses = DEMO_COURSES.filter(course => !config.blockedCourses.some(blocked => blocked.id === course.id));
    setCourses(availableDemoCourses); setSelectedCourseIds(new Set(availableDemoCourses.map(course => course.id))); setSelectedInstructionCourseIds(new Set()); setPreparationProgress({ completed: 3, total: 3, label: 'Course list ready' }); setStage('courses'); setStatus(''); setPreparationProgress(null); setIsPreparingDownload(false);
  }

  async function startFlow() {
    if (isPreparingDownload) return;
    abortedRef.current = false;
    setActiveView('download'); setErrorMessage('');
    if (DEMO_MODE) { await runDemoPreparation(); return; }
    setIsPreparingDownload(true); setStage('ready'); setPreparationProgress({ completed: 0, total: 3, label: 'Connecting to Blackboard' });
    await runWithUiError(async () => {
      // Never send the stored-password mask as a real password; when the mask
      // is shown the worker must fall back to the stored credentials.
      const useStoredPassword = passwordStored && config.password === SAVED_PASSWORD_MASK;
      const hasPassword = useStoredPassword || Boolean(config.password.trim());
      if (!config.username.trim() || !hasPassword) {
        setIsPreparingDownload(false); setPreparationProgress(null);
        throw new Error('Save your Blackboard username and password in Credentials before starting a download.');
      }
      setStatus('Connecting to Blackboard and loading your course list...');
      await window.blackboxGui.workflowStart({ username: config.username || undefined, password: useStoredPassword ? undefined : config.password || undefined, downloadDir: config.downloadDir, headless: config.headless });
      setPreparationProgress({ completed: 1, total: 3, label: 'Loading your course list' });
      if (abortedRef.current) return;
      const discovered = await window.blackboxGui.discoverCourses();
      if (abortedRef.current) return;
      setCourses(discovered); setSelectedCourseIds(new Set(discovered.map(course => course.id))); setSelectedInstructionCourseIds(new Set()); setPreparationProgress({ completed: 3, total: 3, label: 'Course list ready' }); setStage('courses'); setStatus('');
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
    // Demo data exercises both layouts: the first files look saved in the
    // folder structure, the next block saved flat.
    const demoExisting = demoExistingState(DEMO_FILES);
    setExistingByUrl(demoExisting);
    setShowSavedFiles(false);
    setFiles(DEMO_FILES);
    setSelectedFileUrls(new Set(DEMO_FILES.filter(file => !demoExisting[file.url]?.[keepHierarchy ? 'hierarchy' : 'flat']).map(file => file.url)));
    setSelectedInstructionCourseIds(new Set()); setKnownByUrl(new Map(DEMO_FILES.map(file => [file.url, file.size || 0]))); setDownloadState({ completed: 0, failed: 0, skipped: 0, downloadedBytes: 0, totalKnownBytes: 0, unknownCount: 0, speed: 0, currentFile: '' }); setSelectedRunFileCount(0); setSelectedRunInstructionCourseCount(0); setInstructionProgress(null); setDiscoveryProgress(null); setStage('files'); setIsScanningCourses(false);
  }

  async function runScanFiles() {
    if (selectedCourses.length === 0 || isScanningCourses) return;
    abortedRef.current = false;
    setActiveView('download'); setIsScanningCourses(true); setErrorMessage('');
    if (DEMO_MODE) { await runDemoScan(); return; }
    await runWithUiError(async () => {
      try {
        setDiscoveryProgress({ phase: 'courses', completed: 0, total: selectedCourses.length, filesFound: 0 }); setStatus('Scanning selected courses for files...');
        const result = (await window.blackboxGui.discoverFiles(selectedCourses)) as { files: DiscoveredFile[]; existing?: Record<string, ExistingFileState> };
        if (abortedRef.current) return;
        const existing = result.existing || {};
        setFiles(result.files);
        setExistingByUrl(existing);
        setShowSavedFiles(false);
        // Only files the current layout still needs are pre-selected.
        setSelectedFileUrls(new Set(result.files.filter(file => !existing[file.url]?.[keepHierarchy ? 'hierarchy' : 'flat']).map(file => file.url)));
        setSelectedInstructionCourseIds(new Set());
        const known = new Map<string, number>();
        for (const file of result.files) {
          if (typeof file.size === 'number') known.set(file.url, file.size);
          else if (typeof existing[file.url]?.size === 'number') known.set(file.url, existing[file.url].size as number);
        }
        setKnownByUrl(known);
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
    setActiveView('download'); setErrorMessage(''); setIsCancellingDownload(false);
    if (DEMO_MODE) { setRunLayout(keepHierarchy ? 'hierarchy' : 'flat'); await runDemoDownload(selectedFiles, selectedInstructionCourses); return; }
    await runWithUiError(async () => {
      const runSelectedFiles = [...selectedFiles]; const selectedKnownByUrl = new Map<string, number>();
      for (const file of runSelectedFiles) { const knownSize = knownByUrl.get(file.url); if (typeof knownSize === 'number') selectedKnownByUrl.set(file.url, knownSize); else if (typeof file.size === 'number') selectedKnownByUrl.set(file.url, file.size); }
      const runInstructionCourses = [...selectedInstructionCourses];
      const runLayout: 'hierarchy' | 'flat' = keepHierarchy ? 'hierarchy' : 'flat';
      setRunLayout(runLayout);
      const totalKnownBytes = Array.from(selectedKnownByUrl.values()).reduce((total, size) => total + size, 0); selectedRunUrlSetRef.current = new Set(runSelectedFiles.map(file => file.url)); selectedRunKnownByUrlRef.current = selectedKnownByUrl; setTransfer(null); setSelectedRunFileCount(runSelectedFiles.length); setSelectedRunInstructionCourseCount(runInstructionCourses.length); setPerUrlDownloaded(new Map()); setDownloadState({ completed: 0, failed: 0, skipped: 0, downloadedBytes: 0, totalKnownBytes, unknownCount: runSelectedFiles.length - selectedKnownByUrl.size, speed: 0, currentFile: '' }); setInstructionProgress(runInstructionCourses.length > 0 ? { phase: 'discovery', completed: 0, total: runInstructionCourses.length, itemsFound: 0 } : null); setStatus(''); setStage('download');
      try {
        const result = (await window.blackboxGui.downloadFiles(runSelectedFiles, runInstructionCourses, runLayout)) as Summary; setSummary(result); setStage('summary');
        if (result.cancelled) setStatus('Download cancelled. Files and text already saved were kept.');
        else setStatus('');
      } finally {
        setIsCancellingDownload(false);
      }
    });
  }

  /**
   * Stop a running download. The worker aborts in-flight transfers and drops
   * everything still queued; completed files stay on disk, so the run lands on
   * the summary screen with whatever finished.
   */
  async function cancelDownload() {
    if (isCancellingDownload) return;
    if (DEMO_MODE || !window.blackboxGui) { setStatus('Offline demo: cancelling a download is not simulated.'); return; }
    setIsCancellingDownload(true);
    setStatus('Stopping the download. Files already saved are kept.');
    try {
      const result = await window.blackboxGui.cancelDownload();
      if (!result.cancelled) {
        setIsCancellingDownload(false);
        setStatus('No download is running.');
      }
    } catch (error) {
      setIsCancellingDownload(false);
      setErrorMessage(toGuiErrorMessage(error));
    }
  }

  /** Abort before the transfer starts (signing in, loading or scanning courses) and return to the start screen. */
  async function exitWorkflow() {
    abortedRef.current = true;
    setIsPreparingDownload(false); setPreparationProgress(null); setIsScanningCourses(false); setDiscoveryProgress(null);
    setCourses([]); setSelectedCourseIds(new Set()); setSelectedInstructionCourseIds(new Set()); setFiles([]); setSelectedFileUrls(new Set()); setKnownByUrl(new Map()); setSummary(null);
    setStage('ready'); setStatus('Cancelled.');
    if (DEMO_MODE || !window.blackboxGui) return;
    try { await window.blackboxGui.cancelDownload(); await window.blackboxGui.cleanupWorkflow(); } catch { /* nothing was running */ }
  }

  async function saveSettings(testLogin: boolean) {
    await runWithUiError(async () => {
      const keepStoredPassword = passwordStored && config.password === SAVED_PASSWORD_MASK;
      const passwordToSend = keepStoredPassword ? undefined : config.password;
      const passwordToDisplay = keepStoredPassword ? (savedPassword || SAVED_PASSWORD_MASK) : config.password;
      setStatus(testLogin ? 'Saving settings and testing login...' : 'Saving settings...');
      if (DEMO_MODE || !window.blackboxGui) {
        await delay(350);
      } else {
        const result = await window.blackboxGui.saveSetup({ ...config, password: passwordToSend, testLogin }) as { ok?: boolean; loginTestPassed?: boolean; loginTestError?: string };
        if (testLogin && result.loginTestPassed === false) {
          // The save itself succeeded; surface only the failed login test.
          setErrorMessage('Settings were saved, but the login test failed: ' + (result.loginTestError || 'unknown error'));
        }
      }
      setSavedPassword(keepStoredPassword ? savedPassword : passwordToDisplay); setPasswordStored(Boolean(passwordToDisplay)); setPasswordReadable(Boolean(keepStoredPassword ? passwordReadable : passwordToDisplay)); setPasswordError(''); setConfig(previous => ({ ...previous, password: passwordToDisplay })); setHasCredentials(Boolean(config.username.trim()) && Boolean(keepStoredPassword ? passwordReadable : passwordToDisplay)); setStatus(testLogin ? 'Settings saved. Login test requested.' : 'Settings saved.');
    });
  }

  async function resetCredentials() {
    await runWithUiError(async () => {
      if (DEMO_MODE || !window.blackboxGui) await delay(250); else await window.blackboxGui.resetSetup(); setHasCredentials(false); setSavedPassword(''); setPasswordStored(false); setPasswordReadable(false); setPasswordError(''); setConfig(previous => ({ ...previous, username: '', password: '' })); setShowPassword(false); setStatus('Credentials reset.');
    });
  }

  function automationPayload() {
    return {
      gnumbers: automationSettings.gnumbers,
      downloadDir: automationSettings.downloadDir,
      maxFileSizeBytes: Math.max(1, Math.round(automationSettings.maxFileSizeMB * 1024 * 1024)),
      excludedExtensions: automationSettings.excludedExtensionsCsv
        .split(/[,\s]+/)
        .map(ext => ext.trim().toLowerCase())
        .filter(Boolean)
        .map(ext => (ext.startsWith('.') ? ext : '.' + ext)),
    };
  }

  async function saveAutomationSettings(testOnly = false) {
    await runWithUiError(async () => {
      if (DEMO_MODE || !window.blackboxGui) { setStatus('Automation settings saved (offline demo).'); return; }
      const result = await window.blackboxGui.saveAutomationSettings(automationPayload());
      const stored = result.settings as Record<string, unknown>;
      setAutomationSettings(previous => ({
        ...previous,
        gnumbers: Array.isArray(stored.gnumbers) ? (stored.gnumbers as string[]).map(String) : previous.gnumbers,
        downloadDir: String(stored.downloadDir || previous.downloadDir),
      }));
      setStatus('Automation settings saved.');
      if (testOnly) setStatus('Automation settings saved.');
    });
  }

  async function chooseAutomationDirectory() {
    if (DEMO_MODE || !window.blackboxGui) { setStatus('Offline demo: automation folders are represented only.'); return; }
    await runWithUiError(async () => {
      const selected = await window.blackboxGui.chooseAutomationDirectory();
      if (selected) { setAutomationSettings(previous => ({ ...previous, downloadDir: selected })); setStatus('Automation folder selected. Save settings to keep it.'); }
    });
  }

  function openAutomationGnumberModal() {
    setAutomationGnumberDraft(automationSettings.gnumbers.join('\n'));
    setAutomationGnumberModal(true);
  }

  function applyAutomationGnumberDraft() {
    const parsed = parseGnumberList(automationGnumberDraft);
    setAutomationSettings(previous => ({ ...previous, gnumbers: parsed.valid }));
    setAutomationGnumberModal(false);
    setStatus(`Automation G-numbers set: ${parsed.valid.length} valid${parsed.invalid.length > 0 ? `, ${parsed.invalid.length} lines ignored` : ''}.`);
  }

  const parsedGnumberPreview = parseGnumberList(automationGnumberDraft);

  async function startAutomationRun() {
    if (DEMO_MODE || !window.blackboxGui) { setStatus('Offline demo: automatic downloading is not simulated.'); return; }
    await runWithUiError(async () => {
      await window.blackboxGui.saveAutomationSettings(automationPayload());
      setAutomationTab('downloads');
      setIsAutomationRunning(true);
      setAutomationRun({
        running: true,
        total: automationSettings.gnumbers.length,
        parallelSessions: Math.min(4, automationSettings.gnumbers.length) || 1,
        entries: Object.fromEntries(automationSettings.gnumbers.map(gnumber => [gnumber, {
          gnumber,
          status: 'pending' as AutomationGnumberStatus,
          courses: [],
          claimedCourses: [],
          skippedCourses: [],
          filesDownloaded: 0,
          filesFailed: 0,
          filesSkipped: 0,
          instructionsDownloaded: 0,
        }])),
        failedLogins: [],
        uniqueCourses: 0,
        filesDownloaded: 0,
        filesFailed: 0,
        filesSkipped: 0,
        instructionsDownloaded: 0,
      });
      setStatus('Automatic downloading started. The run log is written live into the automation folder.');
      let summary: { succeeded?: number; runlogPath?: string; xlsxPath?: string; debugPath?: string; cancelled?: boolean } | null = null;
      try {
        summary = (await window.blackboxGui.startAutomationRun()) as { succeeded?: number; runlogPath?: string; xlsxPath?: string; debugPath?: string; cancelled?: boolean };
      } catch (error) {
        setAutomationRun(previous => previous ? { ...previous, running: false } : previous);
        throw error;
      }
      setAutomationRun(previous => previous ? {
        ...previous,
        running: false,
        summary: {
          succeeded: Number(summary.succeeded || 0),
          runlogPath: String(summary.runlogPath || ''),
          xlsxPath: String(summary.xlsxPath || ''),
          debugPath: String(summary.debugPath || ''),
          cancelled: Boolean(summary.cancelled),
        },
      } : previous);
      setStatus(summary.cancelled ? 'Automatic downloading cancelled. Finished sessions kept their downloads.' : 'Automatic downloading finished.');
    });
    setIsAutomationRunning(false);
  }

  async function cancelAutomationRun() {
    if (DEMO_MODE || !window.blackboxGui) { return; }
    await runWithUiError(async () => {
      const result = await window.blackboxGui.cancelAutomationRun();
      setStatus(result.cancelled ? 'Cancelling automatic downloading. Sessions finish their current step; downloads are kept.' : 'No automation run is active.');
    });
  }

  async function clearAutomationDownloads() {
    if (DEMO_MODE || !window.blackboxGui) { setStatus('Offline demo: automation folders are represented only.'); return; }
    await runWithUiError(async () => {
      const result = await window.blackboxGui.clearAutomationDownloads();
      setAutomationRun(null);
      setStatus(`Automation folder cleared (${result.removed} entries removed). A new download always starts fresh.`);
    });
  }

  async function openAutomationDirectory() {
    if (DEMO_MODE || !window.blackboxGui) { setStatus('Offline demo: folders are represented only.'); return; }
    const error = await window.blackboxGui.openAutomationDirectory();
    if (error) setErrorMessage(error);
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

  async function installHarness() {
    await runWithUiError(async () => {
      setStatus(DEMO_MODE ? 'Simulating harness skill installation...' : 'Installing the Blackbox skill for compatible harnesses...');
      const result = DEMO_MODE || !window.blackboxGui
        ? { harnessSkill: { ...DEMO_AGENT_STATUS, installed: true, managed: true } }
        : await window.blackboxGui.installHarnessSkill();
      await delay(DEMO_MODE ? 300 : 0);
      setAgentInfo(previous => ({ ...(previous || {}), harnessSkill: result.harnessSkill, harnessInstalled: true }));
      setStatus('Blackbox is available to compatible harnesses.');
    });
  }

  async function removeHarness() {
    await runWithUiError(async () => {
      setStatus(DEMO_MODE ? 'Simulating harness skill removal...' : 'Removing the Blackbox skill from compatible harnesses...');
      const result = DEMO_MODE || !window.blackboxGui
        ? { harnessSkill: { ...DEMO_AGENT_STATUS, installed: false, managed: false } }
        : await window.blackboxGui.removeHarnessSkill();
      await delay(DEMO_MODE ? 300 : 0);
      setAgentInfo(previous => ({ ...(previous || {}), harnessSkill: result.harnessSkill, harnessInstalled: false }));
      setStatus('Blackbox was removed from compatible harnesses.');
    });
  }

  async function checkUpdates() {
    setActiveView('settings'); setSettingsSection('updates'); await runWithUiError(async () => { if (DEMO_MODE || !window.blackboxGui) { setUpdateState({ status: 'idle', message: 'You are on the latest version.' }); return; } setUpdateState(await window.blackboxGui.checkForUpdates()); });
  }

  async function downloadAppUpdate() { await runWithUiError(async () => { if (DEMO_MODE || !window.blackboxGui) return; setUpdateState(await window.blackboxGui.downloadUpdate()); }); }

  async function installAppUpdate() {
    await runWithUiError(async () => {
      if (DEMO_MODE || !window.blackboxGui) return;
      await window.blackboxGui.installUpdate();
    });
  }

  const fileTypes = Array.from(new Set(files.map(file => fileKind(file).toLowerCase()).filter(Boolean)));
  function onNav(id: View) { setErrorMessage(''); setActiveView(id); if (id === 'agent') void loadAgentStatus(); if (id === 'automation') setAutomationTab(previous => previous); }
  const harnessInstalled = harnessSkillInstalled(agentInfo);
  const skillPath = harnessSkillPath(agentInfo);
  const showGlobalStatus = Boolean(status) && !(activeView === 'download' && (isPreparingDownload || isScanningCourses || stage === 'download'));

  return (
    <div className="app">
      <DotWave />
      <WorkspaceNavigation active={activeView} onNavigate={onNav} />

      <main className="stage">
        <WorkspaceHeading active={activeView} credentials={hasCredentials} version={version} demo={DEMO_MODE} />
        <Scene identity={activeView === 'download' ? `download:${stage}:${isPreparingDownload}` : activeView === 'settings' ? `settings:${settingsSection}` : activeView === 'automation' ? `automation:${automationTab}` : activeView} >
        {confirmClear && (
          <div className="modal-overlay" role="dialog" aria-modal="true" data-testid="clear-downloads-modal" onClick={() => setConfirmClear(false)}>
            <Surface className="modal-card panel" onClick={event => event.stopPropagation()}>
              <div className="surface-intro"><div><h2>Clear downloaded files?</h2><p>Every file and folder inside the configured download directory will be deleted. This cannot be undone.</p></div></div>
              <span className="field-help mono">{paths.downloads || config.downloadDir}</span>
              <div className="btn-row">
                <Action className="btn-danger" data-testid="clear-downloads-confirm" onClick={performClearDownloads}><Icon name="x" size={16} /> Clear files</Action>
                <Action className="btn-ghost" autoFocus onClick={() => setConfirmClear(false)}>Cancel</Action>
              </div>
            </Surface>
          </div>
        )}
        {showGlobalStatus && <div className="banner banner-info" role="status"><Icon name="info" size={16} /><span>{status}</span></div>}
        {errorMessage && <div className="banner banner-error" role="alert"><Icon name="alert" size={17} /><span><strong>Something went wrong</strong>{errorMessage}</span></div>}
        {activeView === 'settings' && settingsSection === 'diagnostics' && diagnosticsProgress && <div className="diagnostics-progress-top" data-testid="diagnostics-progress"><ProgressBar label={diagnosticsProgress.running ? (diagnosticsProgress.loginTest ? 'Running diagnostics and login test' : 'Running diagnostics') : 'Diagnostics complete'} value={diagnosticsPercent} detail={`${diagnosticsProgress.completed} / ${diagnosticsProgress.total}`} subdetail={diagnosticsProgress.current} /></div>}

        {activeView === 'download' && stage === 'ready' && isPreparingDownload && <section className="view download-launch" aria-live="polite" data-testid="download-launch"><Surface className="panel launch-panel"><div className="launch-hero"><div className="launch-visual"><div className="launch-orbit"><AppIcon /></div></div><div className="launch-copy"><h2>Preparing your course list</h2><p>{status || 'Connecting to Blackboard and loading the courses available to you.'}</p></div></div><ProgressBar label={preparationProgress?.label || 'Starting'} value={preparationProgress ? (preparationProgress.completed / preparationProgress.total) * 100 : 8} indeterminate={!preparationProgress} detail={preparationProgress ? `${preparationProgress.completed} of ${preparationProgress.total}` : 'Working'} /><div className="launch-stages">{['Connect', 'Discover courses', 'Choose files'].map((label, index) => { const progress = preparationProgress?.completed || 0; const state = progress > index ? 'done' : progress === index ? 'current' : 'todo'; return <div key={label} className={`launch-stage is-${state}`}><span className="stage-number">{state === 'done' ? <Icon name="check" size={14} /> : index + 1}</span><span>{label}</span></div>; })}</div><div className="btn-row"><Action className="btn-ghost" data-testid="prepare-cancel" onClick={exitWorkflow}><Icon name="x" size={16} /> Cancel</Action></div></Surface></section>}

        {activeView === 'download' && stage === 'ready' && !isPreparingDownload && <section className="view"><Surface className="panel ready-panel"><div className="ready-main"><span className="ready-icon"><Icon name="download" size={24} /></span><div><h2>Ready to download</h2><p>Choose courses, review files, and save documents to your configured folder.</p></div></div><div className="ready-actions"><Action className="btn-primary btn-lg" onClick={hasCredentials ? beginDownload : () => { setActiveView('settings'); setSettingsSection('credentials'); }}><Icon name={hasCredentials ? 'download' : 'key'} size={17} />{hasCredentials ? 'Start a download' : 'Open credentials'}</Action><Action className="btn-ghost" onClick={openDownloads}><Icon name="folder" size={17} /> Open downloads</Action><Action className="btn-danger" onClick={clearDownloads}><Icon name="x" size={17} /> Clear downloaded files</Action></div><dl className="ready-meta"><div><dt>Access</dt><dd>{hasCredentials ? 'Credentials ready' : 'Credentials required'}</dd></div><div><dt>Save to</dt><dd className="mono">{paths.downloads || config.downloadDir || '...'}</dd></div></dl></Surface></section>}

        {activeView === 'settings' && <section className="view settings-view"><nav className="settings-tabs" aria-label="Settings sections">{(['credentials', 'courses', 'diagnostics', 'updates'] as SettingsSection[]).map(section => <Action key={section} className={settingsSection === section ? 'is-active' : ''} aria-current={settingsSection === section ? 'page' : undefined} onClick={() => setSettingsSection(section)}>{section === 'credentials' ? 'Credentials' : section === 'courses' ? 'Course filter' : section === 'diagnostics' ? 'Diagnostics' : 'Updates'}</Action>)}</nav>

          {settingsSection === 'credentials' && (
            <Surface className="panel settings-panel" data-testid="credentials-panel">
              <div className="surface-intro"><div><h2>Account access</h2><p>Stored locally on this machine. Your password is kept in the OS secure store.</p></div><span className={`state-badge ${hasCredentials ? 'state-good' : 'state-warn'}`}>{hasCredentials ? 'Ready' : 'Needs setup'}</span></div>
              <div className="form-grid credentials-form">
                <label className="field"><span className="field-label"><Icon name="key" size={14} /> Username / G-number</span><input value={config.username} onChange={event => setConfig(previous => ({ ...previous, username: event.target.value }))} placeholder="g12345678" autoComplete="username" /></label>
                <label className="field"><span className="field-label"><Icon name="lock" size={14} /> Password</span><span className="password-input"><input type={showPassword ? 'text' : 'password'} value={config.password} onFocus={event => { if (config.password === SAVED_PASSWORD_MASK) event.currentTarget.select(); }} onChange={event => { setPasswordStored(false); setPasswordReadable(Boolean(event.target.value)); setPasswordError(''); setConfig(previous => ({ ...previous, password: event.target.value })); }} placeholder="Enter password" autoComplete="current-password" /><Action type="button" className="input-action" aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(value => !value)}><Icon name={showPassword ? 'eye-off' : 'eye'} size={17} /></Action></span><span className="field-help">{passwordError || (passwordStored ? (passwordReadable ? 'Saved password loaded. It is hidden by default.' : 'A saved password is present but cannot be unlocked on this system. Re-enter it to repair secure storage.') : config.password ? 'Password entered. It is hidden by default.' : 'No password saved yet.')}</span></label>
                <div className="field field-wide"><span className="field-label"><Icon name="folder" size={14} /> Download directory</span><div className="path-editor"><input data-testid="download-directory-input" value={config.downloadDir} onChange={event => setConfig(previous => ({ ...previous, downloadDir: event.target.value }))} /><div className="directory-actions"><Action className="btn-secondary" onClick={chooseDownloadDirectory}><Icon name="folder" size={16} /> Choose folder</Action><Action className="btn-ghost" onClick={openDownloads}><Icon name="open" size={16} /> Open directory</Action></div></div><span className="field-help">Files will be saved here. Choose a folder or edit the path, then save settings.</span></div>
                <div className="field field-wide"><span className="field-label"><Icon name="gauge" size={14} /> Background animation</span><DotWaveSetting mode={dotMode} onChange={mode => { setDotMode(mode); saveDotWaveMode(mode); }} /><span className="field-help">A slow dot wave behind the interface. Choose Still or Off to save power; it also stays still when your system asks for reduced motion.</span></div>
                <div className="field field-wide"><span id="browser-mode-label" className="field-label"><Icon name="monitor" size={14} /> Browser mode</span><BrowserModeSlider headless={config.headless} onChange={headless => setConfig(previous => ({ ...previous, headless }))} /><span className="field-help">Headless is the default and keeps the browser hidden. Use Visible when you need to watch a Blackboard sign-in or troubleshoot it.</span></div>
              </div>
              <div className="btn-row"><Action className="btn-primary" onClick={() => saveSettings(false)}><Icon name="check" size={17} /> Save settings</Action><Action className="btn-secondary" onClick={() => saveSettings(true)}><Icon name="shield" size={17} /> Save and test login</Action><Action className="btn-danger" onClick={resetCredentials}><Icon name="refresh" size={17} /> Reset credentials</Action></div>
            </Surface>
          )}

          {settingsSection === 'courses' && (
            <Surface className="panel settings-panel" data-testid="course-settings-panel">
              <div className="surface-intro"><div><h2>Course filter</h2><p>Hide courses you never want to download. Filtered courses are removed from the course list in Downloads.</p></div><span className={'state-badge ' + (config.blockedCourses.length ? 'state-warn' : 'state-neutral')}>{config.blockedCourses.length ? config.blockedCourses.length + ' filtered out' : 'No courses filtered'}</span></div>
              <div className="course-block-actions"><Action className="btn-primary" disabled={isScanningBlockedCourses} onClick={scanBlockedCourses}><Icon name="scan" size={17} className={isScanningBlockedCourses ? 'is-spinning' : ''} /> {isScanningBlockedCourses ? 'Scanning courses...' : 'Scan available courses'}</Action><span className="field-help">Tick a course to filter it out of Downloads. Untick it and save to bring it back.</span></div>
              <div className="course-block-list" aria-busy={isScanningBlockedCourses}>
                {blockedCourseRows.map(course => {
                  const blocked = config.blockedCourses.some(candidate => candidate.id === course.id);
                  return <label key={course.id} className={'list-row ' + (blocked ? 'is-selected' : '')} title={course.name}><input type="checkbox" checked={blocked} disabled={isScanningBlockedCourses} onChange={() => toggleBlockedCourse(course)} /><span className="list-index"><Icon name={blocked ? 'x-circle' : 'book'} size={15} /></span><span className="list-name">{course.name}</span><span className={'list-state ' + (blocked ? 'is-on' : '')}>{blocked ? 'Filtered out' : 'Shown'}</span></label>;
                })}
                {blockedCourseRows.length === 0 && <div className="empty-state"><Icon name="book" size={23} /><strong>No course list yet</strong><span>Scan your available courses to choose permanent filters.</span></div>}
              </div>
              <div className="btn-row"><Action className="btn-primary" onClick={() => saveSettings(false)}><Icon name="check" size={17} /> Save course filters</Action><Action className="btn-ghost" onClick={() => setConfig(previous => ({ ...previous, blockedCourses: [] }))} disabled={config.blockedCourses.length === 0}><Icon name="refresh" size={17} /> Clear filter</Action></div>
            </Surface>
          )}

          {settingsSection === 'diagnostics' && <Surface className="panel settings-panel" data-testid="diagnostics-panel"><div className="surface-intro"><div><h2>Environment checks</h2><p>If Blackboard is not working, run a check here to pinpoint what is failing.</p></div><span className={`state-badge ${doctorRows.length ? 'state-good' : 'state-neutral'}`}>{doctorRows.length ? `${doctorRows.length} results` : 'Not run'}</span></div><div className="btn-row"><Action className="btn-primary" disabled={Boolean(diagnosticsProgress?.running)} onClick={() => runDoctor(false)}><Icon name="scan" size={17} /> Run checks</Action><Action className="btn-secondary" disabled={Boolean(diagnosticsProgress?.running)} onClick={() => runDoctor(true)}><Icon name="shield" size={17} /> Run and login test</Action></div>{doctorRows.length > 0 ? <ul className="checks">{doctorRows.map((row, index) => <li key={`${row.message}-${index}`} className={`check check-${row.status}`}><span className="check-dot"><Icon name={row.status === 'pass' ? 'check' : row.status === 'warn' ? 'warning' : 'x'} size={13} /></span><span className="check-msg">{row.message}</span>{row.required === false && <span className="check-optional">optional</span>}</li>)}</ul> : <p className="empty-inline">No checks run yet.</p>}</Surface>}

          {settingsSection === 'updates' && <Surface className="panel settings-panel" data-testid="updates-panel"><div className="surface-intro"><div><h2>Application updates</h2><p>Keep the desktop app current without interrupting a download.</p></div><span className="state-badge state-neutral">v{version || '...'}</span></div><div className="update-summary"><div><span>Status</span><strong>{String(updateState.status || 'idle')}</strong></div>{updateState.version != null && <div><span>Available</span><strong>{String(updateState.version)}</strong></div>}</div>{updateState.message != null && <p className="inline-message">{String(updateState.message)}</p>}{updateState.status === 'downloading' && <ProgressBar label="Downloading update" value={Number(updateState.percent || 0)} detail={`${Number(updateState.percent || 0).toFixed(0)}%`} />}<label className="toggle-row"><input type="checkbox" checked={config.autoCheckUpdates} onChange={event => setConfig(previous => ({ ...previous, autoCheckUpdates: event.target.checked }))} /><span><strong>Check automatically</strong><small>Look for updates when the app starts.</small></span></label><div className="btn-row"><Action className="btn-primary" disabled={updateState.status === 'checking' || updateState.status === 'downloading'} onClick={checkUpdates}><Icon name="refresh" size={17} /> Check now</Action><Action className="btn-secondary" onClick={() => saveSettings(false)}><Icon name="check" size={17} /> Save preferences</Action>{updateState.status === 'available' && <Action className="btn-secondary" onClick={downloadAppUpdate}><Icon name="download" size={17} /> Download update</Action>}{updateState.status === 'ready' && <Action className="btn-secondary" onClick={installAppUpdate}><Icon name="updates" size={17} /> Restart and install</Action>}</div></Surface>}
        </section>}

{activeView === 'agent' && <section className="view" data-testid="agent-panel"><Surface className="panel agent-panel"><div className="surface-intro"><div><h2>Read-only course context</h2><p>Export instructions, assignments, announcements, and attachments for coding agents. The export never submits work or changes Blackboard.</p></div><span className={`state-badge ${agentInfo?.configured ? 'state-good' : 'state-warn'}`}>{agentInfo?.configured ? 'Configured' : 'Setup needed'}</span></div><div className="agent-summary"><div><span>Workflow</span><strong>{agentInfo?.busy ? 'Busy' : 'Idle'}</strong></div><div><span>Export folder</span><strong className="mono">{String(agentInfo?.downloadDir || paths.downloads || config.downloadDir)}</strong></div></div><div className="agent-actions"><Action className="btn-primary" onClick={syncAgent} disabled={Boolean(agentInfo?.busy) || !agentInfo?.configured}><Icon name="cloud-download" size={17} /> Build export</Action><Action className="btn-secondary" onClick={loadAgentStatus}><Icon name="refresh" size={17} /> Refresh status</Action></div><div className="integration-row"><div><strong>Harness skill</strong><p>Install the managed skill in <code>~/.agents/skills</code>. Compatible harnesses will discover it automatically.</p>{skillPath && <span className="mono">{skillPath}</span>}</div><div className="integration-actions"><span className={`state-badge ${harnessInstalled ? 'state-good' : 'state-neutral'}`}>{harnessInstalled ? 'Installed' : 'Not installed'}</span>{harnessInstalled ? <Action className="btn-danger" onClick={removeHarness}><Icon name="x" size={16} /> Remove from harnesses</Action> : <Action className="btn-secondary" onClick={installHarness}><Icon name="check" size={16} /> Install for harnesses</Action>}</div></div>{agentOutput && <div className="code-block"><pre>{JSON.stringify(agentOutput, null, 2)}</pre></div>}</Surface></section>}

{activeView === 'automation' && <section className="view" data-testid="automation-panel">
  <nav className="settings-tabs" aria-label="Automation sections">
    <Action className={automationTab === 'downloads' ? 'is-active' : ''} aria-current={automationTab === 'downloads' ? 'page' : undefined} onClick={() => setAutomationTab('downloads')}>Downloads</Action>
    <Action className={automationTab === 'settings' ? 'is-active' : ''} aria-current={automationTab === 'settings' ? 'page' : undefined} onClick={() => setAutomationTab('settings')}>Settings</Action>
  </nav>

  {automationTab === 'settings' && (
    <Surface className="panel settings-panel" data-testid="automation-settings-panel">
      <div className="surface-intro"><div><h2>Automation settings</h2><p>Fully independent from your normal Blackbox settings: own G-numbers, own download directory, own limits.</p></div><span className={'state-badge ' + (automationSettings.gnumbers.length ? 'state-good' : 'state-warn')}>{automationSettings.gnumbers.length ? automationSettings.gnumbers.length + ' G-numbers' : 'No G-numbers'}</span></div>
      <div className="form-grid">
        <div className="field field-wide"><span className="field-label"><Icon name="key" size={14} /> G-numbers</span>
          <div className="btn-row">
            <Action className="btn-secondary" onClick={openAutomationGnumberModal} data-testid="automation-paste-gnumbers"><Icon name="file" size={15} /> Paste G-number list</Action>
            <span className="field-help">{automationSettings.gnumbers.length > 0 ? `${automationSettings.gnumbers.length} saved. Each number logs in with itself as the password.` : 'Paste one G-number per line.'}</span>
          </div>
        </div>
        <div className="field field-wide"><span className="field-label"><Icon name="folder" size={14} /> Automation download directory</span>
          <div className="path-editor"><input data-testid="automation-directory-input" value={automationSettings.downloadDir} onChange={event => setAutomationSettings(previous => ({ ...previous, downloadDir: event.target.value }))} placeholder="D:\\Blackbox-Automation" /><div className="directory-actions"><Action className="btn-secondary" onClick={chooseAutomationDirectory}><Icon name="folder" size={16} /> Choose folder</Action><Action className="btn-ghost" onClick={openAutomationDirectory}><Icon name="open" size={16} /> Open directory</Action></div></div>
          <span className="field-help">Must be different from the normal download directory ({automationNormalDir || 'see Settings'}).</span>
        </div>
        <label className="field"><span className="field-label"><Icon name="file" size={14} /> Max file size per file (MB)</span>
          <input type="number" min={1} value={automationSettings.maxFileSizeMB} onChange={event => setAutomationSettings(previous => ({ ...previous, maxFileSizeMB: Math.max(1, Number(event.target.value) || 1) }))} />
          <span className="field-help">Default 100 MB. Larger files are skipped.</span>
        </label>
        <label className="field"><span className="field-label"><Icon name="x-circle" size={14} /> Excluded extensions</span>
          <input value={automationSettings.excludedExtensionsCsv} onChange={event => setAutomationSettings(previous => ({ ...previous, excludedExtensionsCsv: event.target.value }))} placeholder=".mp3, .mp4" />
          <span className="field-help">Comma-separated. Files ending in these extensions are never downloaded.</span>
        </label>
      </div>
      <div className="btn-row"><Action className="btn-primary" onClick={() => saveAutomationSettings(false)}><Icon name="check" size={17} /> Save automation settings</Action></div>
    </Surface>
  )}

  {automationTab === 'downloads' && (
    <Surface className="panel settings-panel" data-testid="automation-downloads-panel">
      <div className="surface-intro"><div><h2>Automatic downloading</h2><p>For every G-number, Blackbox logs in, lists the courses, and downloads everything for each unique course exactly once — in parallel sessions.</p></div><span className={`state-badge ${isAutomationRunning ? 'state-warn' : 'state-neutral'}`}>{isAutomationRunning ? 'Running' : 'Idle'}</span></div>
      <div className="btn-row">
        <Action className="btn-primary btn-lg" data-testid="automation-start" disabled={isAutomationRunning || automationSettings.gnumbers.length === 0 || !automationSettings.downloadDir} onClick={startAutomationRun}><Icon name="cloud-download" size={17} /> Automatic downloading</Action>
        {isAutomationRunning && <Action className="btn-danger" data-testid="automation-cancel" onClick={cancelAutomationRun}><Icon name="x" size={16} /> Cancel download</Action>}
        <Action className="btn-ghost" disabled={isAutomationRunning} data-testid="automation-clear" onClick={clearAutomationDownloads}><Icon name="trash" size={16} /> Clear downloads</Action>
        <Action className="btn-ghost" onClick={openAutomationDirectory}><Icon name="folder" size={16} /> Open folder</Action>
        {automationSettings.gnumbers.length === 0 && <span className="field-help">Save G-numbers in Automation settings first.</span>}
      </div>
      <p className="field-help">Starting a new download wipes the previous downloads and logs first, so every run starts fresh. Cancelling keeps everything already downloaded.</p>
      {automationRun && (
        <div className="automation-run" data-testid="automation-run">
          <div className="summary-grid">
            <div><span>G-numbers</span><strong>{automationRun.total}</strong></div>
            <div><span>Unique courses</span><strong>{automationRun.uniqueCourses}</strong></div>
            <div><span>Files downloaded</span><strong className="text-good">{automationRun.filesDownloaded}</strong></div>
            <div><span>Files failed</span><strong className="text-bad">{automationRun.filesFailed}</strong></div>
            <div><span>Files skipped</span><strong className="text-warn">{automationRun.filesSkipped}</strong></div>
            <div><span>Instructions</span><strong>{automationRun.instructionsDownloaded}</strong></div>
            <div><span>Failed logins</span><strong className="text-bad">{automationRun.failedLogins.length}</strong></div>
            <div><span>Sessions</span><strong>{automationRun.parallelSessions}</strong></div>
          </div>
          <div className="list automation-list">
            {Object.values(automationRun.entries).map(entry => (
              <div key={entry.gnumber} className="list-row automation-row" data-testid={`automation-row-${entry.gnumber}`}>
                <span className="mono">{entry.gnumber}</span>
                <span className={`state-badge ${entry.status === 'done' ? 'state-good' : entry.status === 'failed' ? 'pill-warn' : entry.status === 'pending' ? 'state-neutral' : 'pill-warn'}`}>{entry.status}</span>
                <span className="ellipsis" title={entry.claimedCourses.join(', ') || entry.courses.join(', ')}>
                  {entry.status === 'failed' ? (entry.error || 'Login failed') : `${entry.claimedCourses.length} downloading · ${entry.skippedCourses.length} already covered · ${entry.courses.length} seen`}
                </span>
                <span className="mono">{entry.filesDownloaded}/{entry.filesFailed}±{entry.filesSkipped}</span>
              </div>
            ))}
          </div>
          {automationRun.failedLogins.length > 0 && <ul className="checks">{automationRun.failedLogins.map(failure => <li key={failure.gnumber} className="check check-fail"><span className="check-dot"><Icon name="x" size={13} /></span><span className="check-msg">{failure.gnumber}: {failure.error}</span></li>)}</ul>}
          {automationRun.summary && (
            <div className="btn-row">
              <span className="field-help">Run log: {automationRun.summary.runlogPath} · {automationRun.summary.xlsxPath} · {automationRun.summary.debugPath}</span>
            </div>
          )}
        </div>
      )}
    </Surface>
  )}

  {automationGnumberModal && (
    <div className="modal-overlay" role="dialog" aria-modal="true" data-testid="automation-gnumber-modal" onClick={() => setAutomationGnumberModal(false)}>
      <Surface className="modal-card panel" onClick={event => event.stopPropagation()}>
        <div className="surface-intro"><div><h2>Paste G-numbers</h2><p>One per line (or comma-separated). Each G-number logs in with itself as the password.</p></div></div>
        <textarea
          className="automation-gnumber-input"
          data-testid="automation-gnumber-textarea"
          value={automationGnumberDraft}
          onChange={event => setAutomationGnumberDraft(event.target.value)}
          rows={10}
          placeholder={'g12345678\ng87654321'}
          autoFocus
        />
        <span className="field-help">
          {parsedGnumberPreview.valid.length} valid, {parsedGnumberPreview.invalid.length} invalid{parsedGnumberPreview.invalid.length > 0 ? ` (ignored: ${parsedGnumberPreview.invalid.slice(0, 5).join(', ')}${parsedGnumberPreview.invalid.length > 5 ? '…' : ''})` : ''}
        </span>
        <div className="btn-row">
          <Action className="btn-primary" data-testid="automation-gnumber-save" onClick={applyAutomationGnumberDraft}><Icon name="check" size={16} /> Save list</Action>
          <Action className="btn-ghost" onClick={() => setAutomationGnumberModal(false)}>Cancel</Action>
        </div>
      </Surface>
    </div>
  )}
</section>}


        {activeView === 'download' && (stage === 'courses' || stage === 'files' || stage === 'download' || stage === 'summary') && <section className="view download-view"><div className="download-stepper-row"><Stepper current={wizardStepIndex(stage)} />{(stage === 'courses' || stage === 'files') && <Action className="btn-ghost btn-compact" data-testid="exit-workflow" onClick={exitWorkflow}><Icon name="x" size={15} /> Exit</Action>}{stage !== 'download' && <Action className="btn-danger btn-compact" onClick={clearDownloads}><Icon name="x" size={15} /> Clear downloaded files</Action>}</div>
          {stage === 'courses' && <Surface className="panel selection-panel" data-testid="course-list-panel"><div className="selection-head"><div><h2>Choose courses</h2><p>Select the courses to scan for files.</p></div><CountSummary items={[`${visibleCourses.length} shown`, `${selectedCourseIds.size} selected`, `${courses.length} total`]} /></div>{isScanningCourses && discoveryProgress && <ProgressBar label={discoveryProgress.phase === 'metadata' ? 'Reading file details' : 'Scanning course content'} value={discoveryPercent} detail={`${discoveryProgress.completed} / ${discoveryProgress.total}`} subdetail={discoveryProgress.currentSection || discoveryProgress.currentCourse || 'Working through the selected courses'} dataTestId="discovery-progress" />}<div className="toolbar"><label className="search-field"><Icon name="search" size={16} /><input className="search" placeholder="Filter courses" value={courseSearch} onChange={event => setCourseSearch(event.target.value)} /></label><div className="btn-row btn-row-inline"><Action className="btn-secondary" disabled={isScanningCourses} onClick={() => setSelectedCourseIds(new Set(courses.map(course => course.id)))}><Icon name="check-square" size={16} /> Select all</Action><Action className="btn-ghost" disabled={isScanningCourses} onClick={() => setSelectedCourseIds(new Set())}><Icon name="x" size={16} /> Clear</Action><Action className="btn-primary" disabled={selectedCourses.length === 0 || isScanningCourses} onClick={runScanFiles}><Icon name="scan" size={16} className={isScanningCourses ? 'is-spinning' : ''} /> {isScanningCourses ? 'Scanning...' : 'Scan selected'}</Action>{isScanningCourses && <Action className="btn-danger" data-testid="scan-cancel" onClick={exitWorkflow}><Icon name="x" size={16} /> Cancel</Action>}</div></div><div className="list" aria-busy={isScanningCourses}>{visibleCourses.map((course, index) => { const selected = selectedCourseIds.has(course.id); return <label key={course.id} className={`list-row ${selected ? 'is-selected' : ''}`} title={course.name}><input type="checkbox" checked={selected} disabled={isScanningCourses} onChange={event => setSelectedCourseIds(previous => { const next = new Set(previous); if (event.target.checked) next.add(course.id); else next.delete(course.id); return next; })} /><span className="list-index">{String(index + 1).padStart(2, '0')}</span><span className="list-name">{course.name}</span><span className={`list-state ${selected ? 'is-on' : ''}`}>{selected ? 'Selected' : 'Skipped'}</span></label>; })}{visibleCourses.length === 0 && <div className="empty-state"><Icon name="search-x" size={23} /><strong>No courses found</strong><span>{courses.length ? 'Try a different search.' : 'Start a download to discover courses.'}</span></div>}</div></Surface>}

          {stage === 'files' && (
            <Surface className="panel selection-panel files-panel" data-testid="file-list-panel">
              <div className="selection-head">
                <div>
                  <h2>Choose files</h2>
                  <p>Pick what to save. Files this layout already holds are marked and skipped.</p>
                </div>
                <CountSummary items={[`${pendingFiles.length} to save`, savedFileCount > 0 ? `${savedFileCount} saved` : `${selectableFiles.length} shown`, `${selectedFileUrls.size} selected`, `${files.length} total`]} />
              </div>
              <div className="file-options">
              <CourseInstructionPicker courses={selectedCourses} selectedIds={selectedInstructionCourseIds} expanded={instructionPickerOpen} onToggleExpanded={() => setInstructionPickerOpen(previous => !previous)} onToggle={courseId => setSelectedInstructionCourseIds(previous => { const next = new Set(previous); if (next.has(courseId)) next.delete(courseId); else next.add(courseId); return next; })} onSelectAll={() => setSelectedInstructionCourseIds(new Set())} onClear={() => setSelectedInstructionCourseIds(new Set())} />
              <div className="layout-choice" data-testid="layout-choice">
                <span className="layout-choice-icon"><Icon name="folder" size={16} /></span>
                <div className="layout-choice-copy">
                  <strong>Download layout</strong>
                  <small>{keepHierarchy ? 'Keeps the Blackboard course / section / folder structure.' : 'Puts every file directly in its course folder.'}</small>
                </div>
                <div className={`segmented ${keepHierarchy ? 'is-first' : 'is-second'}`} role="radiogroup" aria-label="Download layout">
                  <span className="segmented-thumb" aria-hidden="true" />
                  <Action type="button" role="radio" aria-checked={keepHierarchy} aria-label="Keep the course folder structure" data-testid="layout-hierarchy" className={keepHierarchy ? 'is-on' : ''} onClick={() => chooseLayout('hierarchy')}>Course folders</Action>
                  <Action type="button" role="radio" aria-checked={!keepHierarchy} aria-label="Save all files flat in the course folder" data-testid="layout-flat" className={keepHierarchy ? '' : 'is-on'} onClick={() => chooseLayout('flat')}>Flat files</Action>
                </div>
              </div>
              </div>
              <div className="toolbar file-toolbar">
                <label className="search-field"><Icon name="search" size={16} /><input className="search" placeholder="Filter files" value={fileSearch} onChange={event => setFileSearch(event.target.value)} /></label>
                <select value={typeFilter} onChange={event => setTypeFilter(event.target.value)} aria-label="Filter by file type">
                  <option value="all">All types</option>
                  {fileTypes.map(type => <option key={type} value={type}>{type.toUpperCase()}</option>)}
                </select>
                <select aria-label="Sort files" data-testid="sort-files" value={sortKey} onChange={event => { const key = event.target.value as SortKey; setSortKey(key); setSortDesc(key === 'size'); }}>
                  <option value="default">Sort: default</option>
                  <option value="name">Sort: name</option>
                  <option value="type">Sort: type</option>
                  <option value="size">Sort: size</option>
                  <option value="course">Sort: course</option>
                </select>
                {sortKey !== 'default' && <Action type="button" className="btn-chip" aria-label={sortDesc ? 'Sorted descending, switch to ascending' : 'Sorted ascending, switch to descending'} onClick={() => setSortDesc(previous => !previous)}>{sortDesc ? '↓ Descending' : '↑ Ascending'}</Action>}
                {savedFileCount > 0 && (
                  <Action type="button" className={`btn-chip ${showSavedFiles ? 'is-on' : ''}`} aria-pressed={showSavedFiles} onClick={() => setShowSavedFiles(previous => !previous)}>
                    <Icon name={showSavedFiles ? 'eye-off' : 'eye'} size={15} /> {showSavedFiles ? 'Hide saved' : `Show ${savedFileCount} saved`}
                  </Action>
                )}
                <div className="btn-row btn-row-inline">
                  <Action className="btn-secondary" disabled={pendingFiles.length === 0} onClick={() => setSelectedFileUrls(new Set(pendingFiles.map(file => file.url)))}><Icon name="check-square" size={16} /> Select all</Action>
                  <Action className="btn-ghost" disabled={selectedFileUrls.size === 0} onClick={() => setSelectedFileUrls(new Set())}><Icon name="x" size={16} /> Clear</Action>
                </div>
              </div>
              <div className="table">
                <div className="table-head"><span /><SortHead label="Name" active={sortKey === 'name'} desc={sortDesc} onClick={() => toggleSort('name')} /><SortHead label="Type" active={sortKey === 'type'} desc={sortDesc} onClick={() => toggleSort('type')} /><SortHead label="Size" className="num" active={sortKey === 'size'} desc={sortDesc} onClick={() => toggleSort('size')} /><SortHead label="Course / section" active={sortKey === 'course'} desc={sortDesc} onClick={() => toggleSort('course')} /><span>State</span></div>
                {sortedFiles.map(file => {
                  const saved = savedInLayout(file.url);
                  const selected = !saved && selectedFileUrls.has(file.url);
                  const size = typeof file.size === 'number' ? file.size : existingByUrl[file.url]?.size;
                  return (
                    <div
                      className={`table-row selectable ${selected ? 'is-on' : ''} ${saved ? 'is-saved' : ''}`}
                      key={file.url}
                      role="checkbox"
                      aria-checked={selected}
                      aria-disabled={saved || undefined}
                      tabIndex={saved ? -1 : 0}
                      onClick={() => toggleFileSelection(file.url)}
                      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleFileSelection(file.url); } }}
                    >
                      <span><input type="checkbox" checked={selected} disabled={saved} onClick={event => event.stopPropagation()} onChange={() => toggleFileSelection(file.url)} /></span>
                      <span className="file-name"><Icon name="file" size={15} /><span className="ellipsis">{file.name}</span></span>
                      <span className="type-cell">{fileKind(file)}</span>
                      <span className="num">{size ? formatBytes(size) : '—'}</span>
                      <span className="ellipsis">{file.courseName} / {file.sectionName}</span>
                      <span className={`tag ${saved ? 'tag-saved' : selected ? 'tag-on' : 'tag-off'}`}>{saved ? 'Saved' : selected ? 'Selected' : 'Ignored'}</span>
                    </div>
                  );
                })}
                {selectableFiles.length === 0 && (
                  <div className="empty-state">
                    <Icon name="search-x" size={23} />
                    <strong>Nothing left to save</strong>
                    <span>{files.length ? (pendingFiles.length === 0 ? 'Every file is already saved for this layout.' : 'Try a different search or type.') : 'Scan selected courses to find files.'}</span>
                  </div>
                )}
              </div>

              <div className="action-bar" data-testid="files-action-bar">
                <div className="action-bar-summary">
                  <strong>{selectedFiles.length} file{selectedFiles.length === 1 ? '' : 's'} selected</strong>
                  <span>
                    {selectedInstructionCourses.length > 0 ? `+ text from ${selectedInstructionCourses.length} course${selectedInstructionCourses.length === 1 ? '' : 's'}` : 'no course text'} · {keepHierarchy ? 'course folders' : 'flat files'}
                  </span>
                </div>
                <Action className="btn-primary btn-lg" data-testid="download-selected" disabled={selectedFiles.length === 0 && selectedInstructionCourses.length === 0} onClick={startDownload}>
                  <Icon name="download" size={17} />
                  {selectedFiles.length > 0 && selectedInstructionCourses.length > 0 ? `Download ${selectedFiles.length} + text` : selectedFiles.length > 0 ? `Download ${selectedFiles.length}` : 'Download instructions'}
                </Action>
              </div>
            </Surface>
          )}

          {stage === 'download' && (
            <Surface className="panel transfer-panel" data-testid="transfer-panel">
              <div className="transfer-head"><div><span className="transfer-status"><span className="live-dot" /> {isCancellingDownload ? 'Stopping transfer' : 'Live transfer'}</span><h2>{selectedRunFileCount > 0 ? 'Downloading selected content' : 'Saving course instructions'}</h2><p>{isCancellingDownload ? 'Finishing the current file, then keeping everything already saved.' : selectedRunFileCount > 0 ? (runLayout === 'flat' ? 'Files are being saved flat inside their course folders.' : 'Files and course text are being saved with the course folder structure.') : 'Every readable item in the included courses is being saved as Markdown.'}</p><p className="mono transfer-destination" title="Folder this run is saving into">Saving to {config.downloadDir}</p></div><div className="transfer-queue"><div className="queue-stat"><strong>{selectedRunFileCount}</strong><span>files queued</span></div>{selectedRunInstructionCourseCount > 0 && <div className="queue-stat queue-stat-instructions"><strong>{selectedRunInstructionCourseCount}</strong><span>courses with text</span></div>}</div></div>
              {selectedRunInstructionCourseCount > 0 && instructionProgress && <ProgressBar label={instructionProgress.phase === 'write' ? 'Saving course instructions' : 'Reading course instructions'} value={instructionPercent} detail={instructionProgress.phase === 'write' ? `${instructionProgress.completed} / ${instructionProgress.total} saved` : `${instructionProgress.itemsFound || 0} items found`} subdetail={instructionProgress.currentTitle || instructionProgress.currentSection || instructionProgress.currentCourse || 'Reading every selected course'} dataTestId="instruction-progress" />}
              {selectedRunFileCount > 0 ? <><ProgressBar label={transfer && transfer.basis === 'files' ? 'Overall progress (by files)' : 'Overall progress'} value={progressPercent} detail={transfer ? (transfer.basis === 'bytes' ? `${formatBytes(transfer.bytes)} / ${formatBytes(transfer.totalBytes)}` : `${transfer.settled} / ${transfer.total} files`) : downloadState.totalKnownBytes > 0 ? `${formatBytes(downloadState.downloadedBytes)} / ${formatBytes(downloadState.totalKnownBytes)}` : `${countProgress} / ${selectedRunFileCount} files`} subdetail={transfer ? `${transfer.settled} of ${transfer.total} files handled${transfer.retrying ? ` · ${transfer.retrying} retrying` : ''}${downloadState.failed ? ` · ${downloadState.failed} failed` : ''}` : (downloadState.failed ? `${downloadState.failed} failed` : 'Starting...')} dataTestId="transfer-progress" /><div className="progress-readout"><strong>{progressPercent.toFixed(1)}%</strong><span>{downloadState.speed > 0 ? `${formatBytes(downloadState.speed)}/s` : (transfer && transfer.settled >= transfer.total ? 'Done' : 'Waiting for data...')}</span></div><div className="download-stats"><div className="download-stat"><span className="download-stat-icon"><Icon name="gauge" size={17} /></span><span><small>Speed</small><strong>{downloadState.speed > 0 ? `${formatBytes(downloadState.speed)}/s` : '–'}</strong></span></div><div className="download-stat"><span className="download-stat-icon"><Icon name="clock" size={17} /></span><span><small>Estimated time</small><strong>{transfer ? (transfer.etaSeconds != null ? eta(transfer.etaSeconds) : transfer.basis === 'files' ? 'Unknown (sizes missing)' : 'Estimating...') : '–'}</strong></span></div><div className="download-stat"><span className="download-stat-icon"><Icon name="file" size={17} /></span><span><small>Unknown size</small><strong>{downloadState.unknownCount}</strong></span></div></div><div className="current-file"><span className="current-file-icon"><Icon name="file" size={17} /></span><span className="current-file-label">Currently saving</span><span className="download-wave" aria-hidden="true"><i /><i /><i /><i /></span><strong className="current-file-name">{transfer && transfer.active.length > 0 ? transfer.active.join('  ·  ') : (downloadState.currentFile || (transfer && transfer.settled >= transfer.total ? 'Finishing up...' : 'Waiting for the first file...'))}</strong></div><div className="tallies"><span className="tally tally-ok"><Icon name="check-circle" size={14} /> {downloadState.completed} done</span><span className="tally tally-skip"><Icon name="clock" size={14} /> {downloadState.skipped} skipped{transfer && transfer.rejected > 0 ? ` (${transfer.rejected} not a supported document)` : ''}</span><span className="tally tally-fail"><Icon name="x-circle" size={14} /> {downloadState.failed} failed</span></div></> : <div className="instruction-only-note"><span className="download-stat-icon"><Icon name="book" size={17} /></span><span><strong>No file attachments selected</strong><small>The course instructions continue independently and will be saved as Markdown.</small></span></div>}
              <div className="btn-row download-footer">{!isCancellingDownload && <Action className="btn-danger" data-testid="download-cancel" onClick={cancelDownload}><Icon name="x" size={16} /> Cancel download</Action>}{isCancellingDownload && <Action className="btn-danger" data-testid="download-cancel" disabled><Icon name="x" size={16} /> Stopping...</Action>}<Action className="btn-ghost" onClick={openDownloads}><Icon name="folder" size={16} /> Open downloads</Action><Action className="btn-ghost" onClick={openLogs}><Icon name="terminal" size={16} /> Open logs</Action></div>
            </Surface>
          )}

          {stage === 'summary' && summary && <Surface className="panel summary-panel"><div className="surface-intro"><div><h2>{summary.cancelled ? 'Download cancelled' : 'Download complete'}</h2><p>{summary.cancelled ? 'Everything saved before the stop is kept in your chosen folder.' : 'Files and course instructions were saved in this read-only run.'}</p><p className="mono">Saved to {summary.downloadDir || config.downloadDir}{typeof summary.durationMs === 'number' ? ` · transfer took ${formatDuration(summary.durationMs)}` : ''}</p></div><span className={`state-badge ${summary.cancelled ? 'state-neutral' : 'state-good'}`}>{summary.cancelled ? 'Cancelled' : 'Finished'}</span></div><div className="summary-grid"><div><span>Files saved as</span><strong>{runLayout === 'flat' ? 'Flat' : 'Folders'}</strong></div>{typeof summary.alreadySaved === 'number' && summary.alreadySaved > 0 && <div><span>Already saved</span><strong>{summary.alreadySaved}</strong></div>}<div><span>Courses scanned</span><strong>{summary.coursesSelected}</strong></div><div><span>Files found</span><strong>{summary.filesDiscovered}</strong></div><div><span>Downloaded</span><strong className="text-good">{summary.filesDownloaded}</strong></div><div><span>Skipped</span><strong className="text-warn">{summary.filesSkipped}</strong></div>{typeof summary.filesRejected === 'number' && summary.filesRejected > 0 && <div><span>Rejected</span><strong className="text-warn">{summary.filesRejected}</strong></div>}<div><span>Failed</span><strong className="text-bad">{summary.filesFailed}</strong></div><div><span>Instruction courses</span><strong>{summary.instructionCoursesSelected}</strong></div><div><span>Instructions saved</span><strong className="text-good">{summary.instructionsDownloaded}</strong></div><div><span>Text discovered</span><strong>{summary.instructionsDiscovered}</strong></div></div>{summary.failedFiles.length > 0 && <ul className="checks">{summary.failedFiles.map(file => <li key={`${file.name}-${file.reason}`} className="check check-fail"><span className="check-dot"><Icon name="x" size={13} /></span><span className="check-msg">{file.name}: {file.reason}</span></li>)}</ul>}{summary.instructionWarnings.length > 0 && <ul className="checks">{summary.instructionWarnings.map(warning => <li key={warning} className="check check-warn"><span className="check-dot"><Icon name="warning" size={13} /></span><span className="check-msg">{warning}</span></li>)}</ul>}<div className="btn-row"><Action className="btn-primary" onClick={beginDownload}><Icon name="refresh" size={16} /> Run again</Action><Action className="btn-ghost" onClick={openDownloads}><Icon name="folder" size={16} /> Open downloads</Action><Action className="btn-ghost" onClick={openLogs}><Icon name="terminal" size={16} /> Open logs</Action></div></Surface>}
        </section>}
        </Scene>
      </main>
      <WorkspaceFooter version={version} downloads={paths.downloads} logs={paths.logs} onDownloads={openDownloads} onLogs={openLogs} />
    </div>
  );
}

function CourseInstructionPicker({
  courses,
  selectedIds,
  onToggle,
  onSelectAll,
  onClear,
  expanded,
  onToggleExpanded,
}: {
  courses: Course[];
  selectedIds: Set<string>;
  onToggle: (courseId: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  return <section className={`instruction-picker ${expanded ? 'is-open' : 'is-collapsed'}`} data-testid="instruction-picker">
    <div className="instruction-picker-head">
      <div>
        <span className="instruction-eyebrow"><Icon name="book" size={14} /> Course-level text</span>
        <h3>Include instructions and text</h3>
        {expanded && <p>Save every readable instruction, assignment, announcement, and text item for the included courses. Individual items are included automatically.</p>}
      </div>
      <div className="instruction-picker-actions">
        <Action type="button" className="btn-chip" data-testid="instruction-picker-toggle" aria-expanded={expanded} onClick={onToggleExpanded}>
          <Icon name="chevron-down" size={15} className={expanded ? 'is-flipped' : ''} />
          {expanded ? 'Done' : selectedIds.size > 0 ? `Text: ${selectedIds.size} course${selectedIds.size === 1 ? '' : 's'}` : 'Add course text'}
        </Action>
      </div>
    </div>
    {expanded && <>
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
      <div className="instruction-picker-footer"><span>{selectedIds.size > 0 ? `${selectedIds.size} course${selectedIds.size === 1 ? '' : 's'} will be scraped completely.` : 'No course instructions selected.'}</span><div className="btn-row btn-row-inline"><Action className="btn-ghost btn-compact" onClick={onSelectAll} disabled={courses.length === 0}>Include all</Action><Action className="btn-ghost btn-compact" onClick={onClear} disabled={selectedIds.size === 0}>Clear</Action></div></div>
    </>}
  </section>;
}

function BrowserModeSlider({ headless, onChange }: { headless: boolean; onChange: (headless: boolean) => void }) {
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(headless ? 0 : 100);
  const [dragging, setDragging] = useState(false);
  const pressedAt = useRef<number | null>(null);
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
    pressedAt.current = event.clientX;
    updateFromClientX(event.clientX);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pressedAt.current === null) return;
    // A plain click glides to its side; only a real drag follows the pointer without easing.
    if (!dragging && Math.abs(event.clientX - pressedAt.current) < 4) return;
    if (!dragging) setDragging(true);
    updateFromClientX(event.clientX);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pressedAt.current === null) return;
    pressedAt.current = null;
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
    <div ref={sliderRef} className="mode-slider" data-mode={headless ? 'headless' : 'visible'} data-dragging={dragging ? 'true' : 'false'} role="slider" tabIndex={0} aria-labelledby="browser-mode-label" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position)} aria-valuetext={headless ? 'Headless, default' : 'Visible browser'} aria-orientation="horizontal" onKeyDown={handleKeyDown} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={() => { pressedAt.current = null; setDragging(false); }}>
      <span className="mode-slider-track" aria-hidden="true"><span className="mode-slider-active" style={{ '--pos': position } as React.CSSProperties} /><span className="mode-slider-thumb" style={thumbLeft === undefined ? undefined : { left: `${thumbLeft}px` }}><Icon name={headless ? 'monitor' : 'eye'} size={14} /></span></span>
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

/**
 * Demo "already saved" state: the first files look saved in the folder
 * structure, the next block looks saved flat, so both layouts are visible in
 * the offline demo without a Blackboard session.
 */
function demoExistingState(files: DiscoveredFile[]): Record<string, ExistingFileState> {
  const state: Record<string, ExistingFileState> = {};
  files.forEach((file, index) => {
    state[file.url] = { hierarchy: index < 12, flat: index >= 12 && index < 20, size: file.size };
  });
  return state;
}

/**
 * Display label for a file's kind. The scan already knows most extensions;
 * falling back to the name keeps the column useful when the metadata pass was
 * skipped for an already-saved file.
 */
function fileKind(file: DiscoveredFile): string {
  const explicit = (file.fileType || '').trim();
  if (explicit) return explicit.toUpperCase();
  const extension = file.name.includes('.') ? file.name.split('.').pop() || '' : '';
  return extension && extension.length <= 5 ? extension.toUpperCase() : 'FILE';
}

function CountSummary({ items }: { items: string[] }) { return <div className="count-summary">{items.map(item => <span key={item}>{item}</span>)}</div>; }
function Stepper({ current }: { current: number }) {
  return <ol className="stepper" aria-label="Download progress">{WIZARD_STEPS.map((label, index) => { const state = index < current ? 'done' : index === current ? 'active' : 'todo'; return <li key={label} className={`step step-${state}`} aria-current={state === 'active' ? 'step' : undefined}><span className="step-dot">{index < current ? <Icon name="check" size={14} /> : index + 1}</span><span className="step-label">{label}</span>{index < WIZARD_STEPS.length - 1 && <span className="step-line" />}</li>; })}</ol>;
}


function SortHead({ label, active, desc, onClick, className = '' }: { label: string; active: boolean; desc: boolean; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`th-sort ${className} ${active ? 'is-active' : ''}`} aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'} title={`Sort by ${label.toLowerCase()}`} onClick={onClick}>
      {label}
      <span className="th-arrow" aria-hidden="true">{active ? (desc ? '↓' : '↑') : ''}</span>
    </button>
  );
}
