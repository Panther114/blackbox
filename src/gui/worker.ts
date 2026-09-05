import { compactConfigOverrides, getConfig } from '../config';
import { writeRunSummary, RunSummaryReport } from '../utils/runSummary';
import { DownloadWorkflow } from '../workflow/downloadWorkflow';
import { AutomationRunner } from '../automation';
import { AutomationSettings } from '../automation/types';
import {
  WorkerCommandMap,
  WorkerCommandMessage,
  WorkerOutgoingMessage,
  WorkerResponseMap,
  WorkerCommandType,
} from './workerProtocol';

let workflow: DownloadWorkflow | null = null;
let runState = {
  coursesDiscovered: 0,
  coursesSelected: 0,
  filesDiscovered: 0,
  filesSelected: 0,
  filesDownloaded: 0,
  filesSkipped: 0,
  filesRejected: 0,
  filesFailed: 0,
  instructionCoursesSelected: 0,
  instructionsDiscovered: 0,
  instructionsDownloaded: 0,
  instructionWarnings: [] as string[],
  skippedOnDisk: 0,
  failedFiles: [] as Array<{ name: string; reason: string }>,
};
let runSummaryContext = {
  startedAt: new Date().toISOString(),
  logFilePath: './logs/blackbox.log',
  downloadDir: './downloads',
};
let stdinBuffer = '';
let commandQueue = Promise.resolve();

function send(message: WorkerOutgoingMessage): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendLog(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
  send({ kind: 'log', level, message });
}

function sendEvent(type: string, payload: unknown): void {
  send({ kind: 'event', type, payload });
}

function resetRunState(): void {
  runState = {
    coursesDiscovered: 0,
    coursesSelected: 0,
    filesDiscovered: 0,
    filesSelected: 0,
    filesDownloaded: 0,
    filesSkipped: 0,
    filesRejected: 0,
    filesFailed: 0,
    instructionCoursesSelected: 0,
    instructionsDiscovered: 0,
    instructionsDownloaded: 0,
    instructionWarnings: [],
    skippedOnDisk: 0,
    failedFiles: [],
  };
}

function buildRunSummaryReport(runError?: string): RunSummaryReport {
  return {
    startedAt: runSummaryContext.startedAt,
    endedAt: new Date().toISOString(),
    coursesDiscovered: runState.coursesDiscovered,
    coursesSelected: runState.coursesSelected,
    filesDiscovered: runState.filesDiscovered,
    filesSelected: runState.filesSelected,
    filesDownloaded: runState.filesDownloaded,
    filesSkipped: runState.filesSkipped + runState.skippedOnDisk,
    filesRejected: runState.filesRejected,
    filesFailed: runState.filesFailed,
    failedFiles: runState.failedFiles,
    instructionCoursesSelected: runState.instructionCoursesSelected,
    instructionsDiscovered: runState.instructionsDiscovered,
    instructionsDownloaded: runState.instructionsDownloaded,
    instructionWarnings: runState.instructionWarnings,
    logFilePath: runSummaryContext.logFilePath,
    downloadDir: runSummaryContext.downloadDir,
    runError,
  };
}

function writeSummarySafely(report: RunSummaryReport): void {
  try {
    writeRunSummary(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendEvent('summary:warning', {
      message: `Run summary could not be written: ${message}`,
    });
  }
}

async function cleanupWorkflow(): Promise<void> {
  const activeWorkflow = workflow;
  workflow = null;
  if (!activeWorkflow) return;
  await activeWorkflow.cleanup();
}

async function startWorkflow(payload: WorkerCommandMap['startWorkflow'] = {}): Promise<WorkerResponseMap['startWorkflow']> {
  await cleanupWorkflow();
  resetRunState();

  const overrides = compactConfigOverrides({
    username: payload.username,
    password: payload.password,
    downloadDir: payload.downloadDir,
    headless: payload.headless,
  });

  const config = getConfig({
    ...overrides,
    courseFilter: undefined,
  });

  const hasUsername = typeof config.username === 'string' && config.username.trim() !== '';
  const hasPassword = typeof config.password === 'string' && config.password.trim() !== '';
  if (!hasUsername || !hasPassword) {
    throw new Error('Blackboard credentials are missing. Open Credentials and save your username/password.');
  }

  runSummaryContext = {
    startedAt: new Date().toISOString(),
    logFilePath: config.logFile,
    downloadDir: config.downloadDir,
  };

  workflow = new DownloadWorkflow(config);
  const eventNames = [
    'login:start',
    'login:success',
    'login:failure',
    'courses:discovered',
    'files:discovery:start',
    'files:discovery:progress',
    'files:discovery:complete',
    'files:metadata:progress',
    'files:metadata:complete',
    'files:ready',
    'instructions:discovery:start',
    'instructions:discovery:progress',
    'instructions:discovery:complete',
    'instructions:write:start',
    'instructions:write:progress',
    'instructions:write:complete',
    'download:start',
    'download:progress',
    'download:complete',
    'download:error',
    'download:skip',
    'download:rejected',
    'summary:ready',
  ];

  for (const eventName of eventNames) {
    workflow.on(eventName, eventPayload => sendEvent(eventName, eventPayload));
  }

  workflow.on('download:complete', () => {
    runState.filesDownloaded += 1;
  });
  workflow.on('download:error', (downloadError: { filename: string; error: string }) => {
    runState.filesFailed += 1;
    runState.failedFiles.push({ name: downloadError.filename, reason: downloadError.error || 'Unknown error' });
  });
  workflow.on('download:skip', () => {
    runState.filesSkipped += 1;
  });
  workflow.on('download:rejected', (rejected: { filename: string; reason?: string }) => {
    runState.filesRejected += 1;
    sendLog('debug', `Rejected file type: ${rejected.filename}`);
  });

  await workflow.initialize();
  return { ok: true, downloadDir: config.downloadDir, logFile: config.logFile };
}

async function discoverCourses(payload: WorkerCommandMap['discoverCourses'] = {}): Promise<WorkerResponseMap['discoverCourses']> {
  if (!workflow) throw new Error('Workflow not started');
  const courses = await workflow.discoverCourses({
    filterPattern: payload.filterPattern,
    excludeCourseIds: payload.excludeCourseIds,
  });
  runState.coursesDiscovered = courses.length;
  return courses;
}

async function discoverFiles(payload: WorkerCommandMap['discoverFiles']): Promise<WorkerResponseMap['discoverFiles']> {
  if (!workflow) throw new Error('Workflow not started');
  const selectedCourses = payload?.courses || [];
  runState.coursesSelected = selectedCourses.length;
  const result = await workflow.discoverFiles(selectedCourses);
  runState.filesDiscovered = result.discovered.length;
  runState.skippedOnDisk = result.skippedOnDisk;
  return result;
}

async function download(payload: WorkerCommandMap['download']): Promise<WorkerResponseMap['download']> {
  if (!workflow) throw new Error('Workflow not started');
  const selectedFiles = payload?.files || [];
  const instructionCourses = payload?.instructionCourses || [];
  runState.filesSelected = selectedFiles.length;
  runState.instructionCoursesSelected = instructionCourses.length;
  try {
    try {
      const instructionResult = await workflow.downloadSelected(selectedFiles, instructionCourses);
      runState.instructionsDiscovered = instructionResult.instructionsDiscovered;
      runState.instructionsDownloaded = instructionResult.instructionsDownloaded;
      runState.instructionWarnings = instructionResult.instructionWarnings;
    } catch (error) {
      const runError = error instanceof Error ? error.message : String(error);
      writeSummarySafely(buildRunSummaryReport(runError));
      throw error;
    }

  const summary = {
    coursesDiscovered: runState.coursesDiscovered,
    coursesSelected: runState.coursesSelected,
    filesDiscovered: runState.filesDiscovered,
    filesSelected: runState.filesSelected,
    filesDownloaded: runState.filesDownloaded,
    filesSkipped: runState.filesSkipped + runState.skippedOnDisk,
    filesRejected: runState.filesRejected,
    filesFailed: runState.filesFailed,
    failedFiles: runState.failedFiles,
    instructionCoursesSelected: runState.instructionCoursesSelected,
    instructionsDiscovered: runState.instructionsDiscovered,
    instructionsDownloaded: runState.instructionsDownloaded,
    instructionWarnings: runState.instructionWarnings,
  };

  writeSummarySafely(buildRunSummaryReport());
  workflow.emitSummary(summary);
  return summary;
  } finally {
    await cleanupWorkflow();
  }
}

async function cleanup(): Promise<WorkerResponseMap['cleanup']> {
  await cleanupWorkflow();
  return { ok: true };
}

async function shutdown(): Promise<WorkerResponseMap['shutdown']> {
  await cleanupWorkflow();
  return { ok: true };
}

/**
 * Batch automation run: one headless Blackboard session per G-number, with
 * course dedupe across sessions. Events stream to the renderer in real time
 * and the JSON/XLSX run log is written into the automation download directory.
 */
async function automationRun(payload: WorkerCommandMap['automationRun']): Promise<WorkerResponseMap['automationRun']> {
  const settings = payload?.settings as AutomationSettings | undefined;
  if (!settings) throw new Error('Automation settings are missing.');
  await cleanupWorkflow();
  const runner = new AutomationRunner(settings, (event) => sendEvent(event.type, event.payload));
  return runner.run();
}

async function handleCommand(
  message: WorkerCommandMessage,
): Promise<WorkerResponseMap[WorkerCommandType]> {
  switch (message.command) {
    case 'startWorkflow':
      return startWorkflow(message.payload as WorkerCommandMap['startWorkflow']);
    case 'discoverCourses':
      return discoverCourses(message.payload as WorkerCommandMap['discoverCourses']);
    case 'discoverFiles':
      return discoverFiles(message.payload as WorkerCommandMap['discoverFiles']);
    case 'download':
      return download(message.payload as WorkerCommandMap['download']);
    case 'automationRun':
      return automationRun(message.payload as WorkerCommandMap['automationRun']);
    case 'cleanup':
      return cleanup();
    case 'shutdown':
      return shutdown();
  }
}

async function processLine(line: string): Promise<void> {
  if (!line.trim()) return;
  let message: WorkerCommandMessage;
  try {
    message = JSON.parse(line) as WorkerCommandMessage;
  } catch {
    sendLog('warn', `Ignoring invalid JSON command: ${line}`);
    return;
  }

  if (message.kind !== 'command' || !message.id || !message.command) {
    sendLog('warn', `Ignoring malformed command: ${line}`);
    return;
  }

  try {
    const data = await handleCommand(message);
    send({ kind: 'response', id: message.id, ok: true, data });
    if (message.command === 'shutdown') {
      // Wait for the pipe write to flush before exiting, otherwise the
      // shutdown response can be truncated on Windows.
      process.stdout.write('', () => process.exit(0));
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    send({ kind: 'response', id: message.id, ok: false, error: messageText });
  }
}

function enqueueCommand(line: string): void {
  commandQueue = commandQueue
    .catch(() => undefined)
    .then(() => processLine(line))
    .catch(error => {
      sendLog('error', `Worker command failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
    });
}

process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => {
  stdinBuffer += chunk;
  const lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop() || '';
  for (const line of lines) {
    enqueueCommand(line);
  }
});

process.on('SIGINT', () => {
  void cleanupWorkflow().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void cleanupWorkflow().finally(() => process.exit(0));
});

send({ kind: 'ready' });
