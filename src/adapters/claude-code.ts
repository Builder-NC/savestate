/**
 * Claude Code Adapter
 *
 * Adapter for Anthropic's Claude Code coding agent.
 * Captures CLAUDE.md files, .claude/ directory state,
 * global settings, and project structure metadata.
 *
 * Claude Code works in project directories with:
 * - CLAUDE.md — project instructions (root + subdirectories)
 * - .claude/ — local state and settings
 * - ~/.claude/ — global settings and instructions
 */

import { readFile, writeFile, readdir, stat, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { homedir } from 'node:os';
import type {
  Adapter,
  PlatformMeta,
  Snapshot,
  MemoryEntry,
  KnowledgeDocument,
  FileManifestEntry,
} from '../types.js';
import { SAF_VERSION, generateSnapshotId, computeChecksum } from '../format.js';

/** Project metadata files to look for */
const PROJECT_META_FILES = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'composer.json',
  'build.gradle',
  'pom.xml',
  'Makefile',
  'CMakeLists.txt',
  'deno.json',
  'deno.jsonc',
  'tsconfig.json',
];

/** Directories to skip during manifest generation */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'venv', '.tox', 'target', '.gradle', '.idea', '.vscode',
  'vendor', 'coverage', '.nyc_output', '.cache', '.parcel-cache',
]);

/** Binary extensions to skip */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp', '.tiff',
  '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.webm', '.avi', '.mov', '.mkv',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.db', '.sqlite', '.sqlite3',
]);

/** Maximum file size to capture (1MB) */
const MAX_FILE_SIZE = 1024 * 1024;

/** Maximum depth for file manifest generation */
const MAX_MANIFEST_DEPTH = 6;

export class ClaudeCodeAdapter implements Adapter {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';
  readonly platform = 'claude-code';
  readonly version = '0.1.0';

  private readonly projectDir: string;
  private warnings: string[] = [];

  constructor(projectDir?: string) {
    this.projectDir = projectDir ?? process.cwd();
  }

  async detect(): Promise<boolean> {
    // Look for CLAUDE.md at project root or .claude/ directory
    const claudeMd = join(this.projectDir, 'CLAUDE.md');
    const claudeDir = join(this.projectDir, '.claude');

    if (existsSync(claudeMd)) {
      // Make sure it's a real file, not a symlink to something else entirely
      // (e.g., CLAUDE.md -> AGENTS.md means this is a Clawdbot workspace)
      return true;
    }
    if (existsSync(claudeDir)) {
      return true;
    }
    return false;
  }

  async extract(): Promise<Snapshot> {
    this.warnings = [];

    const personality = await this.readClaudeMdFiles();
    const memoryEntries = await this.readMemoryFiles();
    const settings = await this.readSettings();
    const projectMeta = await this.readProjectMeta();
    const fileManifest = await this.buildFileManifest();
    const knowledge = await this.buildKnowledge();

    const snapshotId = generateSnapshotId();
    const now = new Date().toISOString();
    const projectType = this.detectProjectType(projectMeta);

    // Log warnings
    if (this.warnings.length > 0) {
      for (const w of this.warnings) {
        console.warn(`  ⚠ ${w}`);
      }
    }

    const snapshot: Snapshot = {
      manifest: {
        version: SAF_VERSION,
        timestamp: now,
        id: snapshotId,
        platform: this.platform,
        adapter: this.id,
        checksum: '',
        size: 0,
      },
      identity: {
        personality,
        config: settings,
        tools: [],
        fileManifest,
        projectMeta,
      },
      memory: {
        core: memoryEntries,
        knowledge,
      },
      conversations: {
        total: 0,
        conversations: [],
      },
      platform: await this.identify(),
      chain: {
        current: snapshotId,
        ancestors: [],
      },
      restoreHints: {
        platform: this.platform,
        steps: [
          {
            type: 'file',
            description: 'Restore CLAUDE.md files to their original locations',
            target: 'identity/',
          },
          {
            type: 'file',
            description: 'Restore .claude/ directory structure',
            target: '.claude/',
          },
          {
            type: 'file',
            description: 'Restore global ~/.claude/ settings',
            target: '~/.claude/',
          },
        ],
        manualSteps: [
          'Verify .claude/settings.json permissions are correct for your workflow',
          'Review restored CLAUDE.md for project-specific paths that may need updating',
        ],
      },
    };

    return snapshot;
  }

  async restore(snapshot: Snapshot): Promise<void> {
    // Restore CLAUDE.md files from concatenated personality
    if (snapshot.identity.personality) {
      await this.restoreClaudeMdFiles(snapshot.identity.personality);
    }

    // Restore .claude/ directory settings
    if (snapshot.identity.config) {
      await this.restoreSettings(snapshot.identity.config as Record<string, unknown>);
    }

    // Restore memory files
    if (snapshot.memory.core.length > 0) {
      await this.restoreMemory(snapshot.memory.core);
    }
  }

  async identify(): Promise<PlatformMeta> {
    const version = await this.detectClaudeCodeVersion();
    const projectType = this.detectProjectType(await this.readProjectMeta());

    return {
      name: 'Claude Code',
      version: version ?? 'unknown',
      exportMethod: 'direct-file-access',
      // Store extra metadata in apiVersion field for project info
      apiVersion: `project-type:${projectType};root:${this.projectDir}`,
    };
  }

  // ─── Private: Reading ─────────────────────────────────────

  /**
   * Read all CLAUDE.md files — root + subdirectories.
   * Concatenates with path markers.
   */
  private async readClaudeMdFiles(): Promise<string> {
    const parts: string[] = [];

    // Root CLAUDE.md
    const rootClaudeMd = join(this.projectDir, 'CLAUDE.md');
    if (existsSync(rootClaudeMd)) {
      const content = await this.safeReadFile(rootClaudeMd);
      if (content !== null) {
        parts.push(`--- CLAUDE.md ---\n${content}`);
      }
    }

    // Search for subdirectory CLAUDE.md files (up to 3 levels deep)
    const subClaudeMds = await this.findFiles('CLAUDE.md', this.projectDir, 3);
    for (const filePath of subClaudeMds) {
      const relPath = relative(this.projectDir, filePath);
      if (relPath === 'CLAUDE.md') continue; // Already handled
      const content = await this.safeReadFile(filePath);
      if (content !== null) {
        parts.push(`--- ${relPath} ---\n${content}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Read memory files from .claude/memory/ and other locations.
   */
  private async readMemoryFiles(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];

    // .claude/todos.md
    const todosPath = join(this.projectDir, '.claude', 'todos.md');
    if (existsSync(todosPath)) {
      const content = await this.safeReadFile(todosPath);
      if (content !== null) {
        const fileStat = await stat(todosPath);
        entries.push({
          id: 'file:.claude/todos.md',
          content,
          source: '.claude/todos.md',
          createdAt: fileStat.birthtime.toISOString(),
          updatedAt: fileStat.mtime.toISOString(),
        });
      }
    }

    // .claude/memory/ directory
    const memoryDir = join(this.projectDir, '.claude', 'memory');
    if (existsSync(memoryDir)) {
      const files = await readdir(memoryDir).catch(() => []);
      for (const file of files) {
        const filePath = join(memoryDir, file);
        const s = await stat(filePath).catch(() => null);
        if (!s?.isFile()) continue;
        const content = await this.safeReadFile(filePath);
        if (content !== null) {
          entries.push({
            id: `file:.claude/memory/${file}`,
            content,
            source: `.claude/memory/${file}`,
            createdAt: s.birthtime.toISOString(),
            updatedAt: s.mtime.toISOString(),
          });
        }
      }
    }

    // Global ~/.claude/CLAUDE.md
    const globalClaudeMd = join(homedir(), '.claude', 'CLAUDE.md');
    if (existsSync(globalClaudeMd)) {
      const content = await this.safeReadFile(globalClaudeMd);
      if (content !== null) {
        const fileStat = await stat(globalClaudeMd);
        entries.push({
          id: 'file:~/.claude/CLAUDE.md',
          content,
          source: '~/.claude/CLAUDE.md',
          createdAt: fileStat.birthtime.toISOString(),
          updatedAt: fileStat.mtime.toISOString(),
          metadata: { global: true },
        });
      }
    }

    return entries;
  }

  /**
   * Read settings from .claude/ and ~/.claude/
   */
  private async readSettings(): Promise<Record<string, unknown> | undefined> {
    const settings: Record<string, string> = {};

    // .claude/settings.json (project)
    const projectSettings = join(this.projectDir, '.claude', 'settings.json');
    if (existsSync(projectSettings)) {
      const content = await this.safeReadFile(projectSettings);
      if (content !== null) {
        settings['.claude/settings.json'] = content;
      }
    }

    // .claude/settings.local.json (local overrides)
    const localSettings = join(this.projectDir, '.claude', 'settings.local.json');
    if (existsSync(localSettings)) {
      const content = await this.safeReadFile(localSettings);
      if (content !== null) {
        settings['.claude/settings.local.json'] = content;
      }
    }

    // ~/.claude/settings.json (global)
    const globalSettings = join(homedir(), '.claude', 'settings.json');
    if (existsSync(globalSettings)) {
      const content = await this.safeReadFile(globalSettings);
      if (content !== null) {
        settings['~/.claude/settings.json'] = content;
      }
    }

    return Object.keys(settings).length > 0 ? settings : undefined;
  }

  /**
   * Read project metadata files (package.json, pyproject.toml, etc.)
   */
  private async readProjectMeta(): Promise<Record<string, string>> {
    const meta: Record<string, string> = {};

    for (const file of PROJECT_META_FILES) {
      const filePath = join(this.projectDir, file);
      if (existsSync(filePath)) {
        const content = await this.safeReadFile(filePath);
        if (content !== null) {
          meta[file] = content;
        }
      }
    }

    return meta;
  }

  /**
   * Build a file manifest of the project (paths + sizes, no content).
   */
  private async buildFileManifest(): Promise<FileManifestEntry[]> {
    const manifest: FileManifestEntry[] = [];
    await this.walkForManifest(this.projectDir, '', manifest, 0);
    return manifest;
  }

  private async walkForManifest(
    dir: string,
    prefix: string,
    manifest: FileManifestEntry[],
    depth: number,
  ): Promise<void> {
    if (depth > MAX_MANIFEST_DEPTH) return;

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && depth === 0 && entry.name !== '.claude') continue;

      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await this.walkForManifest(fullPath, relPath, manifest, depth + 1);
      } else if (entry.isFile()) {
        try {
          const s = await stat(fullPath);
          manifest.push({
            path: relPath,
            size: s.size,
            modified: s.mtime.toISOString(),
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  /**
   * Build knowledge documents from CLAUDE.md files and settings.
   */
  private async buildKnowledge(): Promise<KnowledgeDocument[]> {
    const docs: KnowledgeDocument[] = [];

    const rootClaudeMd = join(this.projectDir, 'CLAUDE.md');
    if (existsSync(rootClaudeMd)) {
      const content = await this.safeReadFile(rootClaudeMd);
      if (content !== null) {
        const buf = Buffer.from(content, 'utf-8');
        docs.push({
          id: 'claude-md:root',
          filename: 'CLAUDE.md',
          mimeType: 'text/markdown',
          path: 'knowledge/CLAUDE.md',
          size: buf.length,
          checksum: computeChecksum(buf),
        });
      }
    }

    return docs;
  }

  // ─── Private: Restore ─────────────────────────────────────

  /**
   * Parse concatenated CLAUDE.md personality back into individual files.
   */
  private async restoreClaudeMdFiles(personality: string): Promise<void> {
    const files = this.parsePersonality(personality);

    for (const [relPath, content] of files) {
      const targetPath = join(this.projectDir, relPath);
      await this.backupFile(targetPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content, 'utf-8');
    }
  }

  /**
   * Restore settings files.
   */
  private async restoreSettings(settings: Record<string, unknown>): Promise<void> {
    for (const [file, value] of Object.entries(settings)) {
      if (typeof value !== 'string') continue;

      let targetPath: string;
      if (file.startsWith('~/')) {
        targetPath = join(homedir(), file.slice(2));
      } else {
        targetPath = join(this.projectDir, file);
      }

      await this.backupFile(targetPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, value, 'utf-8');
    }
  }

  /**
   * Restore memory entries to their source files.
   */
  private async restoreMemory(entries: MemoryEntry[]): Promise<void> {
    for (const entry of entries) {
      let targetPath: string;
      if (entry.source.startsWith('~/')) {
        targetPath = join(homedir(), entry.source.slice(2));
      } else {
        targetPath = join(this.projectDir, entry.source);
      }

      await this.backupFile(targetPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, entry.content, 'utf-8');
    }
  }

  // ─── Private: Utilities ───────────────────────────────────

  private isBinary(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
  }

  private async safeReadFile(filePath: string): Promise<string | null> {
    if (this.isBinary(filePath)) return null;
    try {
      const s = await stat(filePath);
      if (s.size > MAX_FILE_SIZE) {
        this.warnings.push(`Skipped ${filePath} (${(s.size / 1024 / 1024).toFixed(1)}MB > 1MB limit)`);
        return null;
      }
      return await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Find files with a specific name up to maxDepth levels.
   */
  private async findFiles(name: string, dir: string, maxDepth: number, depth = 0): Promise<string[]> {
    if (depth > maxDepth) return [];
    const results: string[] = [];

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.claude') continue;

      const fullPath = join(dir, entry.name);
      if (entry.isFile() && entry.name === name) {
        results.push(fullPath);
      } else if (entry.isDirectory()) {
        const sub = await this.findFiles(name, fullPath, maxDepth, depth + 1);
        results.push(...sub);
      }
    }

    return results;
  }

  private parsePersonality(personality: string): Map<string, string> {
    const files = new Map<string, string>();
    const regex = /^--- (.+?) ---$/gm;
    const matches = [...personality.matchAll(regex)];

    for (let i = 0; i < matches.length; i++) {
      const filename = matches[i][1];
      const startIdx = matches[i].index! + matches[i][0].length + 1;
      const endIdx = i + 1 < matches.length ? matches[i + 1].index! : personality.length;

      let content = personality.slice(startIdx, endIdx);
      content = content.replace(/\n\n$/, '\n');
      if (!content.endsWith('\n')) content += '\n';

      files.set(filename, content);
    }

    return files;
  }

  private async backupFile(filePath: string): Promise<void> {
    if (existsSync(filePath)) {
      const backupPath = filePath + '.bak';
      try {
        await rename(filePath, backupPath);
      } catch {
        // Continue without backup
      }
    }
  }

  /**
   * Try to detect Claude Code version from common locations.
   */
  private async detectClaudeCodeVersion(): Promise<string | null> {
    // Check if claude is on PATH and get version
    // We can't run a command here, but we can look for version files
    const versionLocations = [
      join(homedir(), '.claude', 'version'),
      join(homedir(), '.claude', '.version'),
    ];

    for (const loc of versionLocations) {
      if (existsSync(loc)) {
        try {
          const v = await readFile(loc, 'utf-8');
          return v.trim();
        } catch {
          // ignore
        }
      }
    }

    return null;
  }

  /**
   * Detect project type from metadata files.
   */
  private detectProjectType(meta: Record<string, string>): string {
    if (meta['Cargo.toml']) return 'rust';
    if (meta['pyproject.toml']) return 'python';
    if (meta['go.mod']) return 'go';
    if (meta['Gemfile']) return 'ruby';
    if (meta['composer.json']) return 'php';
    if (meta['build.gradle'] || meta['pom.xml']) return 'java';
    if (meta['deno.json'] || meta['deno.jsonc']) return 'deno';
    if (meta['package.json']) return 'node';
    if (meta['CMakeLists.txt']) return 'cpp';
    if (meta['Makefile']) return 'make';
    return 'unknown';
  }
}
