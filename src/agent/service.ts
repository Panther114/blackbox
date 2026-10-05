import path from 'path';
import { compactConfigOverrides, getConfig } from '../config';
import { BlackboxDownloader } from '../index';
import { AgentAttachment, Course } from '../types';
import { writeAgentExport } from './exporter';
import { getHarnessSkillStatus, installHarnessSkill, removeHarnessSkill } from './harnessSkill';
import { acquireWorkflowLock, getWorkflowLockStatus } from '../workflow/runLock';

export interface AgentSyncOptions {
  courseIds?: string[];
  includeFiles?: boolean;
  includeInstructions?: boolean;
  outputDir?: string;
}

export interface CourseListOptions {
  username?: string;
  password?: string;
  downloadDir?: string;
  headless?: boolean;
}

export class AgentService {
  async status(): Promise<Record<string, unknown>> {
    const config = getConfig();
    return {
      ...getWorkflowLockStatus(),
      configured: Boolean(config.username && config.password),
      downloadDir: path.resolve(config.downloadDir),
      harnessSkill: getHarnessSkillStatus(),
    };
  }

  installHarnessSkill(): Record<string, unknown> {
    const config = getConfig();
    return { harnessSkill: installHarnessSkill(config.downloadDir) };
  }

  removeHarnessSkill(): Record<string, unknown> {
    return { harnessSkill: removeHarnessSkill() };
  }

  async listCourses(options: CourseListOptions = {}): Promise<Course[]> {
    const release = acquireWorkflowLock('agent:list-courses');
    let downloader: BlackboxDownloader | null = null;
    try {
      const config = getConfig(
        compactConfigOverrides({
          username: options.username,
          password: options.password,
          downloadDir: options.downloadDir,
          headless: options.headless,
        }),
      );
      downloader = new BlackboxDownloader(config);
      await downloader.initialize();
      return await downloader.getCourses();
    } finally {
      // Release the lock even when cleanup() throws, otherwise the process
      // stays permanently busy after a single failed browser close.
      try {
        await downloader?.cleanup();
      } finally {
        release();
      }
    }
  }

  async sync(options: AgentSyncOptions = {}): Promise<Record<string, unknown>> {
    const release = acquireWorkflowLock('agent:sync');
    let downloader: BlackboxDownloader | null = null;
    try {
      const config = getConfig();
      downloader = new BlackboxDownloader(config);
      await downloader.initialize();
      const allCourses = await downloader.getCourses();
      const courses = options.courseIds?.length
        ? allCourses.filter(course => options.courseIds?.includes(course.id))
        : allCourses;
      const result = await downloader.discoverAgentContent(courses, Boolean(options.includeInstructions ?? true));
      let attachments: AgentAttachment[] = result.attachments;
      if (options.includeFiles) {
        const files = await downloader.fetchFileMetadata(result.files);
        const outcomes = await downloader.downloadSelected(files);
        // Report the real per-file result; a failed or rejected download must
        // never be described as "downloaded" in the manifest.
        attachments = attachments.map(attachment => {
          const outcome = outcomes[attachment.url]?.status;
          const status: AgentAttachment['status'] =
            outcome === 'completed'
              ? 'downloaded'
              : outcome === 'failed'
                ? 'failed'
                : outcome === 'skipped' || outcome === 'rejected'
                  ? 'skipped'
                  : 'pending';
          return { ...attachment, status };
        });
      }
      const exportResult = writeAgentExport({
        outputDir: options.outputDir || config.downloadDir,
        baseUrl: config.baseUrl,
        courses,
        items: result.items,
        attachments,
        warnings: result.warnings,
      });
      return { manifestPath: exportResult.manifestPath, ...exportResult.manifest.summary, warnings: exportResult.manifest.warnings };
    } finally {
      try {
        await downloader?.cleanup();
      } finally {
        release();
      }
    }
  }
}
