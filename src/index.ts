import path from 'path';
import { EventEmitter } from 'events';
import {
  AgentAttachment,
  Config,
  ContentItem,
  Course,
  DiscoveredFile,
  DownloadableFile,
  FileTree,
  InstructionDiscoveryProgress,
} from './types';
import { BlackboardAuth } from './auth';
import { BlackboardScraper } from './scraper';
import { FileDownloader } from './downloader';
import { DownloadDatabase } from './database';
import { initLogger, log } from './utils/logger';
import { ensureDirectory, sanitizeFilename } from './utils/helpers';
import { loadFileTree, saveFileTree, buildFileTreeFromDisk } from './fileTree';
import { stableId } from './agent/markdown';

/** Maximum folder-nesting depth before recursion is aborted. */
const MAX_DISCOVER_DEPTH = 10;

export class BlackboxDownloader extends EventEmitter {
  private config: Config;
  private auth: BlackboardAuth;
  private scraper: BlackboardScraper | null = null;
  private downloader: FileDownloader | null = null;
  private db: DownloadDatabase;
  private fileTree: FileTree;

  constructor(config: Config) {
    super();
    this.config = config;

    // Initialize logger first (required by other components)
    initLogger(config.logLevel, config.logFile);

    this.auth = new BlackboardAuth(config);
    this.db = new DownloadDatabase(config.databasePath);

    // Load or build the file tree cache
    this.fileTree = loadFileTree(config.fileTreePath);
    if (Object.keys(this.fileTree.courses).length === 0) {
      // No existing tree — migrate from disk
      log.info('No file tree cache found — scanning downloads folder to build initial tree...');
      this.fileTree = buildFileTreeFromDisk(config.downloadDir);
      saveFileTree(this.fileTree, config.fileTreePath);
    }
  }

  /**
   * Return the loaded file tree (for use by CLI or other consumers).
   */
  getFileTree(): FileTree {
    return this.fileTree;
  }

  /**
   * Persist the current in-memory file tree to disk.
   */
  saveFileTree(): void {
    saveFileTree(this.fileTree, this.config.fileTreePath);
  }

  /**
   * Initialize and authenticate
   */
  async initialize(): Promise<void> {
    log.info('Initializing Blackbox...');

    await this.auth.launchBrowser();
    await this.auth.login();

    const page = this.auth.getPage();
    const cookies = await this.auth.getCookies();

    this.scraper = new BlackboardScraper(page, this.config);
    this.downloader = new FileDownloader(this.config, cookies, this.db, this.fileTree);

    // Forward FileDownloader events to BlackboxDownloader
    this.downloader.on('download:start', (data) => this.emit('download:start', data));
    this.downloader.on('download:progress', (data) => this.emit('download:progress', data));
    this.downloader.on('download:complete', (data) => this.emit('download:complete', data));
    this.downloader.on('download:error', (data) => this.emit('download:error', data));
    this.downloader.on('download:skip', (data) => this.emit('download:skip', data));
    this.downloader.on('download:rejected', (data) => this.emit('download:rejected', data));
    this.downloader.on('files:metadata:progress', (data) => this.emit('files:metadata:progress', data));
    this.downloader.on('files:metadata:complete', (data) => this.emit('files:metadata:complete', data));

    log.info('Initialization complete');
  }

  // ---------------------------------------------------------------------------
  // Discovery phase — navigate the entire course tree, return all files
  // ---------------------------------------------------------------------------

  /**
   * Return the list of all courses available to the logged-in user.
   * Call this before the course selection GUI so the user can pick which
   * courses to scrape.
   */
  async getCourses(): Promise<Course[]> {
    if (!this.scraper) {
      throw new Error('Not initialized. Call initialize() first.');
    }
    return this.scraper.getCourses();
  }

  /**
   * Traverse every course → section → folder recursively and return a flat
   * list of DiscoveredFile objects.  No downloads are performed.
   * Call this before presenting the GUI selection to the user.
   *
   * @param courses - Optional pre-selected courses to scrape. When omitted all
   *   courses returned by `getCourses()` are scraped (backward-compatible).
   */
  async discoverAllFiles(courses?: Course[]): Promise<DiscoveredFile[]> {
    if (!this.scraper) {
      throw new Error('Not initialized. Call initialize() first.');
    }

    ensureDirectory(this.config.downloadDir);

    const resolvedCourses = courses ?? (await this.scraper.getCourses());

    if (resolvedCourses.length === 0) {
      log.warn('No courses found');
      return [];
    }

    log.info(`Discovering files in ${resolvedCourses.length} courses...`);

    const allFiles: DiscoveredFile[] = [];
    this.emit('files:discovery:progress', {
      phase: 'courses',
      completed: 0,
      total: resolvedCourses.length,
      currentCourse: '',
      currentSection: '',
      filesFound: 0,
    });

    for (let courseIndex = 0; courseIndex < resolvedCourses.length; courseIndex += 1) {
      const course = resolvedCourses[courseIndex];
      log.info(`${'='.repeat(60)}`);
      log.info(`Discovering course: ${course.name}`);
      log.info('='.repeat(60));

      const coursePath = path.join(this.config.downloadDir, course.path);
      ensureDirectory(coursePath);

      try {
        const sidebarLinks = await this.scraper.getSidebarLinks(course.url);
        this.emit('files:discovery:progress', {
          phase: 'courses',
          completed: courseIndex,
          total: resolvedCourses.length,
          currentCourse: course.name,
          currentSection: '',
          filesFound: allFiles.length,
        });

        for (let sectionIndex = 0; sectionIndex < sidebarLinks.length; sectionIndex += 1) {
          const link = sidebarLinks[sectionIndex];
          log.info(`  Scanning section: ${link.title}`);
          this.emit('files:discovery:progress', {
            phase: 'courses',
            completed: courseIndex,
            total: resolvedCourses.length,
            currentCourse: course.name,
            currentSection: link.title,
            filesFound: allFiles.length,
          });

          const sectionPath = path.join(coursePath, link.path);
          ensureDirectory(sectionPath);

          const ok = await this.scraper.navigateTo(link.url);
          if (!ok) {
            log.warn(`  Skipping section "${link.title}" — navigation failed`);
            continue;
          }

          const sectionFiles = await this.discoverFolder(
            sectionPath,
            course.name,
            link.title
          );
          allFiles.push(...sectionFiles);
        }

        // Return to home between courses
        await this.scraper.returnToHome();

        log.info(`✓ Finished discovering course: ${course.name}`);
      } catch (error: any) {
        log.error(`Failed to discover course ${course.name}: ${error.message}`);
      }

      this.emit('files:discovery:progress', {
        phase: 'courses',
        completed: courseIndex + 1,
        total: resolvedCourses.length,
        currentCourse: course.name,
        currentSection: '',
        filesFound: allFiles.length,
      });
    }

    log.info(`Discovery complete — found ${allFiles.length} files total`);
    return allFiles;
  }

  /** Read-only content and attachment discovery used by agent mode. */
  async discoverAgentContent(
    courses: Course[],
    includeInstructions = true,
  ): Promise<{ items: ContentItem[]; files: DiscoveredFile[]; attachments: AgentAttachment[]; warnings: string[] }> {
    if (!this.scraper) throw new Error('Not initialized. Call initialize() first.');
    const items: ContentItem[] = [];
    const files: DiscoveredFile[] = [];
    const warnings: string[] = [];

    for (const course of courses) {
      try {
        const links = await this.scraper.getSidebarLinks(course.url, { includeAnnouncements: true });
        for (const link of links) {
          if (!(await this.scraper.navigateTo(link.url))) {
            warnings.push(`Could not open ${course.name} / ${link.title}`);
            continue;
          }
          const found = await this.discoverContentFolder(course, link.title, [], includeInstructions, true, 0, false);
          items.push(...found.items);
          files.push(...found.files);
        }
        await this.scraper.returnToHome();
      } catch (error) {
        warnings.push(`Could not scan ${course.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const attachments: AgentAttachment[] = files.map(file => ({
      id: stableId('attachment', file.url),
      name: file.name,
      url: file.url,
      courseName: file.courseName,
      sectionName: file.sectionName,
      localPath: path.join(file.savePath, file.name),
      relativePath: path.relative(this.config.downloadDir, path.join(file.savePath, file.name)),
      size: file.size,
      mimeType: file.mimeType,
      status: 'pending',
    }));
    return { items, files, attachments, warnings };
  }

  /**
   * Read every readable content item for the selected courses. This shares the
   * same announcement/content extraction path as agent mode but deliberately
   * skips attachment discovery so manual file selection remains independent.
   */
  async discoverInstructions(
    courses: Course[],
    onProgress?: (progress: InstructionDiscoveryProgress) => void,
  ): Promise<{ items: ContentItem[]; warnings: string[] }> {
    if (!this.scraper) throw new Error('Not initialized. Call initialize() first.');

    const items: ContentItem[] = [];
    const warnings: string[] = [];
    onProgress?.({ phase: 'courses', completed: 0, total: courses.length, currentCourse: '', currentSection: '', itemsFound: 0 });

    for (let courseIndex = 0; courseIndex < courses.length; courseIndex += 1) {
      const course = courses[courseIndex];
      try {
        const links = await this.scraper.getSidebarLinks(course.url, { includeAnnouncements: true });
        onProgress?.({
          phase: 'courses',
          completed: courseIndex,
          total: courses.length,
          currentCourse: course.name,
          currentSection: '',
          itemsFound: items.length,
        });

        for (const link of links) {
          onProgress?.({
            phase: 'sections',
            completed: courseIndex,
            total: courses.length,
            currentCourse: course.name,
            currentSection: link.title,
            itemsFound: items.length,
          });

          if (!(await this.scraper.navigateTo(link.url))) {
            warnings.push(`Could not open ${course.name} / ${link.title}`);
            continue;
          }

          const found = await this.discoverContentFolder(course, link.title, [], true, false, 0);
          items.push(...found.items);
          onProgress?.({
            phase: 'sections',
            completed: courseIndex,
            total: courses.length,
            currentCourse: course.name,
            currentSection: link.title,
            itemsFound: items.length,
          });
        }
        await this.scraper.returnToHome();
      } catch (error) {
        warnings.push(`Could not scan ${course.name}: ${error instanceof Error ? error.message : String(error)}`);
      }

      onProgress?.({
        phase: 'courses',
        completed: courseIndex + 1,
        total: courses.length,
        currentCourse: course.name,
        currentSection: '',
        itemsFound: items.length,
      });
    }

    return { items, warnings };
  }

  private async discoverContentFolder(
    course: Course,
    sectionName: string,
    folderPath: string[],
    includeInstructions: boolean,
    includeFiles: boolean,
    depth: number,
    createDirectories = true,
  ): Promise<{ items: ContentItem[]; files: DiscoveredFile[] }> {
    if (!this.scraper || depth >= MAX_DISCOVER_DEPTH) return { items: [], files: [] };
    const currentPath = path.join(this.config.downloadDir, course.path, sanitizeFilename(sectionName), ...folderPath.map(sanitizeFilename));
    // Read-only discovery passes createDirectories=false so a content-only
    // scan never litters the download directory with empty folders.
    if (createDirectories) ensureDirectory(currentPath);
    const items = includeInstructions ? await this.scraper.getContentItems(course, sectionName, folderPath) : [];
    const rawFiles = includeFiles ? await this.scraper.getDownloadableFiles(currentPath) : [];
    const files: DiscoveredFile[] = rawFiles.map(file => ({
      name: file.name,
      url: file.url,
      courseName: course.name,
      sectionName,
      savePath: currentPath,
      size: file.size,
      mimeType: file.mimeType,
      fileType: path.extname(file.name).slice(1).toUpperCase() || undefined,
      status: 'pending' as const,
    }));
    const folders = await this.scraper.getSubfolders(currentPath);
    for (const folder of folders) {
      if (!(await this.scraper.navigateTo(folder.url))) continue;
      const nested = await this.discoverContentFolder(course, sectionName, [...folderPath, folder.name], includeInstructions, includeFiles, depth + 1);
      items.push(...nested.items);
      files.push(...nested.files);
      await this.scraper.goBack();
    }
    return { items, files };
  }

  /**
   * Recursively discover files in the current page (already navigated to).
   * Does NOT download anything.
   * `depth` is incremented on every recursive call; if it reaches MAX_DISCOVER_DEPTH
   * a warning is emitted and recursion stops to prevent stack overflows on
   * unusual or circular course structures.
   */
  private async discoverFolder(
    currentPath: string,
    courseName: string,
    sectionName: string,
    depth = 0
  ): Promise<DiscoveredFile[]> {
    if (!this.scraper) return [];

    if (depth >= MAX_DISCOVER_DEPTH) {
      log.warn(
        `    Max folder depth (${MAX_DISCOVER_DEPTH}) reached in "${sectionName}" — ` +
          'stopping recursion to prevent infinite loops on circular course structures.'
      );
      return [];
    }

    const discovered: DiscoveredFile[] = [];

    // Files on this page
    const rawFiles = await this.scraper.getDownloadableFiles(currentPath);
    for (const f of rawFiles) {
      const ext = f.name ? path.extname(f.name).slice(1).toUpperCase() : undefined;
      discovered.push({
        name: f.name,
        url: f.url,
        courseName,
        sectionName,
        savePath: currentPath,
        size: f.size,
        mimeType: f.mimeType,
        fileType: ext || undefined,
        status: 'pending',
      });
    }

    if (discovered.length > 0) {
      log.debug(`    Discovered ${discovered.length} files in "${sectionName}"`);
    }

    // Recurse into subfolders
    const subfolders = await this.scraper.getSubfolders(currentPath);

    for (const subfolder of subfolders) {
      log.info(`    Entering subfolder: ${subfolder.name}`);

      const subfolderPath = path.join(currentPath, subfolder.path);
      ensureDirectory(subfolderPath);

      const ok = await this.scraper.navigateTo(subfolder.url);
      if (!ok) {
        log.warn(`    Skipping subfolder "${subfolder.name}" — navigation failed`);
        continue;
      }

      const subFiles = await this.discoverFolder(subfolderPath, courseName, sectionName, depth + 1);
      discovered.push(...subFiles);

      // Navigate back after processing the subfolder
      await this.scraper.goBack();
    }

    return discovered;
  }

  // ---------------------------------------------------------------------------
  // Download phase
  // ---------------------------------------------------------------------------

  /**
   * Fetch HEAD metadata (size / MIME type) for a list of discovered files.
   * Delegates to FileDownloader.fetchMetadata().
   */
  async fetchFileMetadata(files: DiscoveredFile[]): Promise<DiscoveredFile[]> {
    if (!this.downloader) {
      throw new Error('Not initialized. Call initialize() first.');
    }
    return this.downloader.fetchMetadata(files);
  }

  /**
   * Download only the files the user selected in the GUI.
   * Returns a per-URL outcome map so callers can report accurate statuses.
   */
  async downloadSelected(files: DiscoveredFile[]): Promise<Record<string, { status: string; error?: string }>> {
    if (!this.downloader) {
      throw new Error('Not initialized. Call initialize() first.');
    }

    if (files.length === 0) {
      log.warn('No files to download');
      return {};
    }

    const outcomes = await this.downloader.downloadSelected(files);
    this.printStats();
    return outcomes;
  }

  // ---------------------------------------------------------------------------
  // Convenience wrapper (backward compatibility)
  // ---------------------------------------------------------------------------

  /**
   * Discover all files then download all of them without any GUI selection.
   * Kept for backward compatibility and scripted use.
   */
  async downloadAll(): Promise<void> {
    const allFiles = await this.discoverAllFiles();

    if (allFiles.length === 0) {
      log.warn('No downloadable files found');
      return;
    }

    // Fetch metadata (size / MIME) so downloads have proper filenames and types
    const enriched = await this.fetchFileMetadata(allFiles);

    log.info(`Processing ${enriched.length} files...`);

    // Convert DiscoveredFile → DownloadableFile and download in one global batch
    const downloadable: DownloadableFile[] = enriched.map(f => ({
      name: f.name,
      url: f.url,
      path: f.savePath,
      size: f.size,
      mimeType: f.mimeType,
      status: 'pending' as const,
    }));

    if (!this.downloader) throw new Error('Not initialized');
    await this.downloader.downloadFiles(downloadable);

    this.printStats();
  }

  // ---------------------------------------------------------------------------
  // Statistics / cleanup
  // ---------------------------------------------------------------------------

  private printStats(): void {
    if (!this.downloader) return;

    const stats = this.downloader.getStats();

    log.info('\n' + '='.repeat(60));
    log.info('DOWNLOAD SUMMARY');
    log.info('='.repeat(60));
    log.info(`Total files:     ${stats.total}`);
    log.info(`Completed:       ${stats.completed}`);
    log.info(`Failed:          ${stats.failed}`);
    log.info(`Pending:         ${stats.pending}`);
    log.info('='.repeat(60));
  }

  async cleanup(): Promise<void> {
    await this.auth.close();
    this.db.close();
    log.info('Cleanup complete');
  }
}
