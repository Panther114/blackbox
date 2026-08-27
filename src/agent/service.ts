import path from 'path';
import { getConfig } from '../config';
import { BlackboxDownloader } from '../index';
import { AgentAttachment, Course } from '../types';
import { writeAgentExport } from './exporter';
import { getCodexSkillStatus, installCodexSkill, removeCodexSkill } from './codexSkill';
import { acquireWorkflowLock, getWorkflowLockStatus } from '../workflow/runLock';

export interface AgentSyncOptions {
  courseIds?: string[];
  includeFiles?: boolean;
  includeInstructions?: boolean;
  outputDir?: string;
}

export class AgentService {
  async status(): Promise<Record<string, unknown>> {
    const config = getConfig();
    return {
      ...getWorkflowLockStatus(),
      configured: Boolean(config.username && config.password),
      downloadDir: path.resolve(config.downloadDir),
      codexSkill: getCodexSkillStatus(),
    };
  }

  installCodexSkill(): Record<string, unknown> {
    const config = getConfig();
    return { codexSkill: installCodexSkill(config.downloadDir) };
  }

  removeCodexSkill(): Record<string, unknown> {
    return { codexSkill: removeCodexSkill() };
  }

  async listCourses(): Promise<Course[]> {
    const release = acquireWorkflowLock('agent:list-courses');
    let downloader: BlackboxDownloader | null = null;
    try {
      downloader = new BlackboxDownloader(getConfig());
      await downloader.initialize();
      return await downloader.getCourses();
    } finally {
      await downloader?.cleanup();
      release();
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
        await downloader.downloadSelected(files);
        attachments = attachments.map(attachment => ({ ...attachment, status: 'downloaded', localPath: path.join(config.downloadDir, attachment.courseName, attachment.sectionName, attachment.name) }));
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
      await downloader?.cleanup();
      release();
    }
  }
}
