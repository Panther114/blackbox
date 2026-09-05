/// <reference types="vite/client" />

declare global {
  interface Window {
    blackboxGui: {
      getVersion: () => Promise<string>;
      loadConfig: () => Promise<Record<string, unknown>>;
      saveSetup: (payload: Record<string, unknown>) => Promise<{ ok: boolean }>;
      resetSetup: () => Promise<{ ok: boolean }>;
      runDoctor: (payload?: { loginTest?: boolean }) => Promise<Array<Record<string, unknown>>>;
      workflowStart: (payload?: Record<string, unknown>) => Promise<{ ok: boolean }>;
      discoverCourses: (payload?: { filterPattern?: string }) => Promise<
        Array<{ id: string; name: string; url: string; path: string }>
      >;
      discoverFiles: (
        courses: Array<{ id: string; name: string; url: string; path: string }>,
      ) => Promise<Record<string, unknown>>;
      downloadFiles: (
        files: Array<{
          name: string;
          url: string;
          courseName: string;
          sectionName: string;
          savePath: string;
          size?: number;
          fileType?: string;
        }>,
        instructionCourses?: Array<{ id: string; name: string; url: string; path: string }>,
      ) => Promise<Record<string, unknown>>;
      cleanupWorkflow: () => Promise<{ ok: boolean }>;
      getPaths: () => Promise<{ downloads: string; logs: string; summary: string }>;
      openDownloads: () => Promise<string>;
      clearDownloads: (payload?: { downloadDir?: string }) => Promise<{ ok: boolean; removed: number; directory: string }>;
      openLogs: () => Promise<string>;
      chooseDownloadDirectory: () => Promise<string | null>;
      scanCourses: (payload?: Record<string, unknown>) => Promise<Array<{ id: string; name: string; url: string; path: string }>>;
      getAgentStatus: () => Promise<Record<string, unknown>>;
      syncAgent: (payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
      installHarnessSkill: () => Promise<Record<string, unknown>>;
      removeHarnessSkill: () => Promise<Record<string, unknown>>;
      getUpdateState: () => Promise<Record<string, unknown>>;
      checkForUpdates: () => Promise<Record<string, unknown>>;
      downloadUpdate: () => Promise<Record<string, unknown>>;
      installUpdate: () => Promise<{ ok: boolean }>;
      loadAutomationSettings: () => Promise<{ settings: Record<string, unknown>; normalDownloadDir: string }>;
      saveAutomationSettings: (payload: Record<string, unknown>) => Promise<{ ok: boolean; settings: Record<string, unknown> }>;
      chooseAutomationDirectory: () => Promise<string | null>;
      openAutomationDirectory: () => Promise<string>;
      startAutomationRun: () => Promise<Record<string, unknown>>;
      onWorkflowEvent: (handler: (event: { type: string; payload: unknown }) => void) => () => void;
    };
  }
}

export {};

