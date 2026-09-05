import { contextBridge, ipcRenderer } from 'electron';
import { Course, DiscoveredFile } from '../types';

type WorkflowEvent = { type: string; payload: unknown };

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  loadConfig: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('config:load'),
  saveSetup: (payload: Record<string, unknown>): Promise<{ ok: boolean; loginTestPassed?: boolean; loginTestError?: string }> =>
    ipcRenderer.invoke('setup:save', payload),
  resetSetup: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('setup:reset'),
  runDoctor: (payload?: { loginTest?: boolean }): Promise<Array<Record<string, unknown>>> =>
    ipcRenderer.invoke('doctor:run', payload || {}),
  workflowStart: (payload?: Record<string, unknown>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('workflow:start', payload || {}),
  discoverCourses: (payload?: { filterPattern?: string }): Promise<Course[]> =>
    ipcRenderer.invoke('workflow:discover-courses', payload || {}),
  discoverFiles: (courses: Course[]): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('workflow:discover-files', { courses }),
  downloadFiles: (files: DiscoveredFile[], instructionCourses: Course[] = []): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('workflow:download', { files, instructionCourses }),
  cleanupWorkflow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('workflow:cleanup'),
  getPaths: (): Promise<{ downloads: string; logs: string; summary: string }> =>
    ipcRenderer.invoke('paths:get'),
  openDownloads: (): Promise<string> => ipcRenderer.invoke('path:open-downloads'),
  clearDownloads: (payload?: { downloadDir?: string }): Promise<{ ok: boolean; removed: number; directory: string }> =>
    ipcRenderer.invoke('path:clear-downloads', payload || {}),
  openLogs: (): Promise<string> => ipcRenderer.invoke('path:open-logs'),
  chooseDownloadDirectory: (): Promise<string | null> => ipcRenderer.invoke('path:choose-download-directory'),
  scanCourses: (payload?: Record<string, unknown>): Promise<Array<{ id: string; name: string; url: string; path: string }>> =>
    ipcRenderer.invoke('settings:scan-courses', payload || {}),
  getAgentStatus: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('agent:status'),
  syncAgent: (payload?: Record<string, unknown>): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('agent:sync', payload || {}),
  installHarnessSkill: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('agent:harness-install'),
  removeHarnessSkill: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('agent:harness-remove'),
  getUpdateState: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('update:get-state'),
  checkForUpdates: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('update:install'),
  loadAutomationSettings: (): Promise<{ settings: Record<string, unknown>; normalDownloadDir: string }> =>
    ipcRenderer.invoke('automation:load-settings'),
  saveAutomationSettings: (payload: Record<string, unknown>): Promise<{ ok: boolean; settings: Record<string, unknown> }> =>
    ipcRenderer.invoke('automation:save-settings', payload),
  chooseAutomationDirectory: (): Promise<string | null> => ipcRenderer.invoke('automation:choose-directory'),
  openAutomationDirectory: (): Promise<string> => ipcRenderer.invoke('automation:open-directory'),
  startAutomationRun: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('automation:start-run'),
  onWorkflowEvent: (handler: (event: WorkflowEvent) => void): (() => void) => {
    const listener = (_: unknown, evt: WorkflowEvent) => handler(evt);
    ipcRenderer.on('workflow:event', listener);
    return () => ipcRenderer.removeListener('workflow:event', listener);
  },
};

contextBridge.exposeInMainWorld('blackboxGui', api);

