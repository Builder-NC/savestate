/**
 * Clawdbot Adapter
 *
 * First-party adapter for Clawdbot / Moltbot workspaces.
 * Reads SOUL.md, MEMORY.md, memory/, USER.md, TOOLS.md,
 * skills/, personal-scripts/, extensions/, conversation logs,
 * cron wrappers, and config files.
 *
 * This is the dogfood adapter — SaveState eats its own cooking.
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
  ConversationMeta,
  SkillEntry,
  ScriptEntry,
  ExtensionEntry,
} from '../types.js';
import { SAF_VERSION, generateSnapshotId, computeChecksum } from '../format.js';

/** Files that constitute the agent's identity */
const IDENTITY_FILES = ['SOUL.md', 'USER.md', 'AGENTS.md', 'TOOLS.md'];

/** Directories containing memory data */
const MEMORY_DIRS = ['memory'];

/** Files containing memory data */
const MEMORY_FILES = ['memory.md', 'MEMORY.md'];

/** Config files to capture at workspace root */
const CONFIG_FILES = ['.env', 'config.json', 'config.yaml', 'config.yml', '.savestate/config.json'];

/** File extensions to skip as binary */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp', '.tiff',
  '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.webm', '.avi', '.mov', '.mkv',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.db', '.sqlite', '.sqlite3',
  '.DS_Store',
]);

/** Maximum file size to capture (1MB) */
const MAX_FILE_SIZE = 1024 * 1024;

/** Separator used in concatenated personality */
const FILE_SEPARATOR_PREFIX = '--- ';
const FILE_SEPARATOR_SUFFIX = ' ---';

/** Directories to skip when scanning */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);

export class ClawdbotAdapter implements Adapter {
  readonly id = 'clawdbot';
  readonly name = 'Clawdbot';
  readonly platform = 'clawdbot';
  readonly version = '0.2.0';

  private readonly workspaceDir: string;
  private warnings: string[] = [];

  constructor(workspaceDir?: string) {
    this.workspaceDir = workspaceDir ?? process.cwd();
  }

  async detect(): Promise<boolean> {
    // Detect by looking for characteristic files
    const markers = ['SOUL.md', 'memory.md', 'AGENTS.md', 'memory/'];
    for (const marker of markers) {
      if (existsSync(join(this.workspaceDir, marker))) {
        return true;
      }
    }
    return false;
  }

  async extract(): Promise<Snapshot> {
    this.warnings = [];

    const personality = await this.readIdentity();
    const memoryEntries = await this.readMemory();
    const conversations = await this.readConversations();
    const skills = await this.readSkills();
    const scripts = await this.readScripts();
    const extensions = await this.readExtensions();
    const configEntries = await this.readConfigFiles();
    const knowledge = await this.buildKnowledgeIndex(skills, scripts);

    const snapshotId = generateSnapshotId();
    const now = new Date().toISOString();

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
        checksum: '', // Computed during packing
        size: 0,      // Computed during packing
      },
      identity: {
        personality,
        config: configEntries,
        tools: [],
        skills,
        scripts,
        extensions,
      },
      memory: {
        core: memoryEntries,
        knowledge,
      },
      conversations: {
        total: conversations.length,
        conversations,
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
            description: 'Restore SOUL.md and identity files',
            target: 'identity/',
          },
          {
            type: 'file',
            description: 'Restore memory files',
            target: 'memory/',
          },
          {
            type: 'file',
            description: 'Restore skills directory',
            target: 'skills/',
          },
          {
            type: 'file',
            description: 'Restore personal scripts',
            target: 'personal-scripts/',
          },
          {
            type: 'file',
            description: 'Restore extension configs',
            target: 'extensions/',
          },
        ],
      },
    };

    return snapshot;
  }

  async restore(snapshot: Snapshot): Promise<void> {
    // Restore identity files from concatenated personality
    if (snapshot.identity.personality) {
      await this.restoreIdentity(snapshot.identity.personality);
    }

    // Restore memory files
    await this.restoreMemory(snapshot.memory.core);

    // Restore skills
    if (snapshot.identity.skills?.length) {
      await this.restoreSkills(snapshot.identity.skills);
    }

    // Restore scripts
    if (snapshot.identity.scripts?.length) {
      await this.restoreScripts(snapshot.identity.scripts);
    }

    // Restore extensions
    if (snapshot.identity.extensions?.length) {
      await this.restoreExtensions(snapshot.identity.extensions);
    }

    // Restore config files
    if (snapshot.identity.config) {
      await this.restoreConfigFiles(snapshot.identity.config as Record<string, unknown>);
    }
  }

  async identify(): Promise<PlatformMeta> {
    // Try to read version from package.json in the workspace
    let version = this.version;
    try {
      const pkg = await readFile(join(this.workspaceDir, 'package.json'), 'utf-8');
      const parsed = JSON.parse(pkg) as Record<string, unknown>;
      if (typeof parsed.version === 'string') {
        version = parsed.version;
      }
    } catch { /* ignore */ }

    return {
      name: 'Clawdbot',
      version,
      exportMethod: 'direct-file-access',
    };
  }

  // ─── Private helpers ─────────────────────────────────────

  /**
   * Check if a file should be skipped (binary or too large).
   */
  private isBinary(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    const base = filePath.split('/').pop() ?? '';
    return BINARY_EXTENSIONS.has(ext) || BINARY_EXTENSIONS.has(`.${base}`);
  }

  private async checkFileSize(filePath: string): Promise<boolean> {
    try {
      const s = await stat(filePath);
      if (s.size > MAX_FILE_SIZE) {
        this.warnings.push(`Skipped ${filePath} (${(s.size / 1024 / 1024).toFixed(1)}MB > 1MB limit)`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async safeReadFile(filePath: string): Promise<string | null> {
    if (this.isBinary(filePath)) {
      return null;
    }
    if (!(await this.checkFileSize(filePath))) {
      return null;
    }
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  private async readIdentity(): Promise<string> {
    const parts: string[] = [];
    for (const file of IDENTITY_FILES) {
      const path = join(this.workspaceDir, file);
      if (existsSync(path)) {
        const content = await this.safeReadFile(path);
        if (content !== null) {
          parts.push(`--- ${file} ---\n${content}`);
        }
      }
    }
    return parts.join('\n\n');
  }

  private async readMemory(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];

    // Read standalone memory files
    for (const file of MEMORY_FILES) {
      const path = join(this.workspaceDir, file);
      if (existsSync(path)) {
        const content = await this.safeReadFile(path);
        if (content !== null) {
          const fileStat = await stat(path);
          entries.push({
            id: `file:${file}`,
            content,
            source: file,
            createdAt: fileStat.birthtime.toISOString(),
            updatedAt: fileStat.mtime.toISOString(),
          });
        }
      }
    }

    // Read memory directory (recursively, flat output)
    for (const dir of MEMORY_DIRS) {
      const dirPath = join(this.workspaceDir, dir);
      if (existsSync(dirPath)) {
        const memFiles = await this.walkDir(dirPath, ['.md', '.json', '.txt']);
        for (const filePath of memFiles) {
          const content = await this.safeReadFile(filePath);
          if (content !== null) {
            const relPath = `${dir}/${relative(dirPath, filePath)}`;
            const fileStat = await stat(filePath);
            entries.push({
              id: `file:${relPath}`,
              content,
              source: relPath,
              createdAt: fileStat.birthtime.toISOString(),
              updatedAt: fileStat.mtime.toISOString(),
            });
          }
        }
      }
    }

    return entries;
  }

  private async readConversations(): Promise<ConversationMeta[]> {
    const conversations: ConversationMeta[] = [];

    // Look for conversation logs in ~/.clawdbot/agents/*/sessions/*.jsonl
    const agentsDir = join(homedir(), '.clawdbot', 'agents');
    if (!existsSync(agentsDir)) return conversations;

    try {
      const agents = await readdir(agentsDir);
      for (const agent of agents) {
        const sessionsDir = join(agentsDir, agent, 'sessions');
        if (!existsSync(sessionsDir)) continue;

        const sessionFiles = await readdir(sessionsDir);
        for (const sessionFile of sessionFiles) {
          if (!sessionFile.endsWith('.jsonl')) continue;

          const sessionPath = join(sessionsDir, sessionFile);
          const sessionId = sessionFile.replace('.jsonl', '');

          try {
            const fileStat = await stat(sessionPath);

            // Count lines (messages) without loading full content
            let messageCount = 0;
            if (fileStat.size <= MAX_FILE_SIZE) {
              const content = await readFile(sessionPath, 'utf-8');
              messageCount = content.split('\n').filter(l => l.trim()).length;
            } else {
              this.warnings.push(`Conversation ${sessionId} too large for content (${(fileStat.size / 1024 / 1024).toFixed(1)}MB), capturing metadata only`);
            }

            conversations.push({
              id: `${agent}/${sessionId}`,
              title: `${agent} session ${sessionId.slice(0, 8)}`,
              createdAt: fileStat.birthtime.toISOString(),
              updatedAt: fileStat.mtime.toISOString(),
              messageCount,
              path: `conversations/${agent}/${sessionFile}`,
            });
          } catch {
            // Skip unreadable session files
          }
        }
      }
    } catch {
      // Agents directory not readable
    }

    return conversations;
  }

  /**
   * Read skills/ directory — capture SKILL.md and scripts/ for each skill.
   */
  private async readSkills(): Promise<SkillEntry[]> {
    const skills: SkillEntry[] = [];
    const skillsDir = join(this.workspaceDir, 'skills');
    if (!existsSync(skillsDir)) return skills;

    try {
      const skillDirs = await readdir(skillsDir);
      for (const skillName of skillDirs) {
        const skillPath = join(skillsDir, skillName);
        const s = await stat(skillPath).catch(() => null);
        if (!s?.isDirectory()) continue;

        const entry: SkillEntry = { name: skillName, files: {} };

        // Read SKILL.md
        const skillMdPath = join(skillPath, 'SKILL.md');
        if (existsSync(skillMdPath)) {
          const content = await this.safeReadFile(skillMdPath);
          if (content !== null) {
            entry.skillMd = content;
            entry.files['SKILL.md'] = content;
          }
        }

        // Read config files in skill root
        const skillFiles = await readdir(skillPath).catch(() => []);
        for (const f of skillFiles) {
          if (SKIP_DIRS.has(f)) continue;
          const fPath = join(skillPath, f);
          const fStat = await stat(fPath).catch(() => null);
          if (!fStat?.isFile()) continue;
          if (this.isBinary(fPath)) continue;

          // Capture config-like files: .json, .yaml, .yml, .toml, .md, .txt, .sh, .py, .ts, .js
          const ext = extname(f).toLowerCase();
          const captureExts = new Set(['.json', '.yaml', '.yml', '.toml', '.md', '.txt', '.sh', '.py', '.ts', '.js', '.env']);
          if (!captureExts.has(ext)) continue;

          const content = await this.safeReadFile(fPath);
          if (content !== null) {
            entry.files[f] = content;
          }
        }

        // Read scripts/ subdirectory
        const scriptsDir = join(skillPath, 'scripts');
        if (existsSync(scriptsDir)) {
          const scriptFiles = await this.walkDir(scriptsDir, ['.sh', '.py', '.ts', '.js', '.rb']);
          for (const sf of scriptFiles) {
            const content = await this.safeReadFile(sf);
            if (content !== null) {
              const relPath = `scripts/${relative(scriptsDir, sf)}`;
              entry.files[relPath] = content;
            }
          }
        }

        if (Object.keys(entry.files).length > 0 || entry.skillMd) {
          skills.push(entry);
        }
      }
    } catch {
      // skills directory not readable
    }

    return skills;
  }

  /**
   * Read personal-scripts/ and personal-scripts/cron-wrappers/
   */
  private async readScripts(): Promise<ScriptEntry[]> {
    const scripts: ScriptEntry[] = [];
    const scriptsDir = join(this.workspaceDir, 'personal-scripts');
    if (!existsSync(scriptsDir)) return scripts;

    try {
      const allFiles = await this.walkDir(scriptsDir);
      for (const filePath of allFiles) {
        const content = await this.safeReadFile(filePath);
        if (content !== null) {
          const relPath = `personal-scripts/${relative(scriptsDir, filePath)}`;
          const isCronWrapper = filePath.includes('cron-wrappers');
          scripts.push({ path: relPath, content, isCronWrapper });
        }
      }
    } catch {
      // personal-scripts not readable
    }

    return scripts;
  }

  /**
   * Read extensions/ directory configs (skip node_modules and binary files).
   */
  private async readExtensions(): Promise<ExtensionEntry[]> {
    const extensions: ExtensionEntry[] = [];
    const extDir = join(this.workspaceDir, 'extensions');
    if (!existsSync(extDir)) return extensions;

    try {
      const extDirs = await readdir(extDir);
      for (const extName of extDirs) {
        const extPath = join(extDir, extName);
        const s = await stat(extPath).catch(() => null);
        if (!s?.isDirectory()) continue;

        const entry: ExtensionEntry = { name: extName, configs: {} };

        // Only capture config-like files (not source code or node_modules)
        const configExts = new Set(['.json', '.yaml', '.yml', '.toml', '.md', '.env', '.env.example']);
        const files = await readdir(extPath).catch(() => []);
        for (const f of files) {
          if (SKIP_DIRS.has(f)) continue;
          const fPath = join(extPath, f);
          const fStat = await stat(fPath).catch(() => null);
          if (!fStat?.isFile()) continue;

          const ext = extname(f).toLowerCase();
          if (configExts.has(ext) || f === 'package.json' || f === 'README.md' || f === 'SKILL.md') {
            const content = await this.safeReadFile(fPath);
            if (content !== null) {
              entry.configs[f] = content;
            }
          }
        }

        if (Object.keys(entry.configs).length > 0) {
          extensions.push(entry);
        }
      }
    } catch {
      // extensions directory not readable
    }

    return extensions;
  }

  /**
   * Read config files from workspace root.
   */
  private async readConfigFiles(): Promise<Record<string, unknown> | undefined> {
    const configs: Record<string, string> = {};

    for (const file of CONFIG_FILES) {
      const filePath = join(this.workspaceDir, file);
      if (existsSync(filePath)) {
        const content = await this.safeReadFile(filePath);
        if (content !== null) {
          configs[file] = content;
        }
      }
    }

    // Also check .savestate/agent-config.json
    const agentConfigPath = join(this.workspaceDir, '.savestate', 'agent-config.json');
    if (existsSync(agentConfigPath)) {
      const content = await this.safeReadFile(agentConfigPath);
      if (content !== null) {
        configs['.savestate/agent-config.json'] = content;
      }
    }

    return Object.keys(configs).length > 0 ? configs : undefined;
  }

  /**
   * Build knowledge documents index from skills and scripts.
   */
  private async buildKnowledgeIndex(
    skills: SkillEntry[],
    scripts: ScriptEntry[],
  ): Promise<KnowledgeDocument[]> {
    const docs: KnowledgeDocument[] = [];

    for (const skill of skills) {
      if (skill.skillMd) {
        const buf = Buffer.from(skill.skillMd, 'utf-8');
        docs.push({
          id: `skill:${skill.name}`,
          filename: `skills/${skill.name}/SKILL.md`,
          mimeType: 'text/markdown',
          path: `knowledge/skills/${skill.name}/SKILL.md`,
          size: buf.length,
          checksum: computeChecksum(buf),
        });
      }
    }

    for (const script of scripts) {
      const buf = Buffer.from(script.content, 'utf-8');
      docs.push({
        id: `script:${script.path}`,
        filename: script.path,
        mimeType: 'text/plain',
        path: `knowledge/${script.path}`,
        size: buf.length,
        checksum: computeChecksum(buf),
      });
    }

    return docs;
  }

  private async readJsonSafe(path: string): Promise<Record<string, unknown> | undefined> {
    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  /**
   * Walk a directory recursively and return file paths matching optional extensions.
   */
  private async walkDir(dir: string, extensions?: string[]): Promise<string[]> {
    const results: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue; // Skip hidden files/dirs

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await this.walkDir(fullPath, extensions);
        results.push(...sub);
      } else if (entry.isFile()) {
        if (this.isBinary(fullPath)) continue;
        if (extensions) {
          const ext = extname(entry.name).toLowerCase();
          if (!extensions.includes(ext)) continue;
        }
        results.push(fullPath);
      }
    }

    return results;
  }

  // ─── Restore helpers ──────────────────────────────────────

  /**
   * Parse concatenated personality back into individual files and write them.
   * Files are joined with `--- FILENAME ---` markers.
   */
  private async restoreIdentity(personality: string): Promise<void> {
    const files = this.parsePersonality(personality);

    for (const [filename, content] of files) {
      const targetPath = join(this.workspaceDir, filename);

      // Backup existing file
      await this.backupFile(targetPath);

      // Write restored content
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content, 'utf-8');
    }
  }

  /**
   * Parse the concatenated personality string into individual files.
   * Format: `--- FILENAME ---\ncontent\n\n--- NEXTFILE ---\ncontent`
   */
  private parsePersonality(personality: string): Map<string, string> {
    const files = new Map<string, string>();
    const regex = /^--- (.+?) ---$/gm;
    const matches = [...personality.matchAll(regex)];

    for (let i = 0; i < matches.length; i++) {
      const filename = matches[i][1];
      const startIdx = matches[i].index! + matches[i][0].length + 1; // +1 for newline
      const endIdx = i + 1 < matches.length ? matches[i + 1].index! : personality.length;

      let content = personality.slice(startIdx, endIdx);
      // Trim trailing newlines between sections (but keep content intact)
      content = content.replace(/\n\n$/, '\n');
      if (!content.endsWith('\n')) content += '\n';

      files.set(filename, content);
    }

    return files;
  }

  /**
   * Restore memory entries back to their source files.
   */
  private async restoreMemory(entries: MemoryEntry[]): Promise<void> {
    for (const entry of entries) {
      const targetPath = join(this.workspaceDir, entry.source);

      // Backup existing file
      await this.backupFile(targetPath);

      // Ensure directory exists
      await mkdir(dirname(targetPath), { recursive: true });

      // Write restored content
      await writeFile(targetPath, entry.content, 'utf-8');
    }
  }

  /**
   * Restore skills back to skills/ directory.
   */
  private async restoreSkills(skills: SkillEntry[]): Promise<void> {
    for (const skill of skills) {
      const skillDir = join(this.workspaceDir, 'skills', skill.name);
      await mkdir(skillDir, { recursive: true });

      for (const [relPath, content] of Object.entries(skill.files)) {
        const targetPath = join(skillDir, relPath);
        await this.backupFile(targetPath);
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, content, 'utf-8');
      }
    }
  }

  /**
   * Restore personal scripts.
   */
  private async restoreScripts(scripts: ScriptEntry[]): Promise<void> {
    for (const script of scripts) {
      const targetPath = join(this.workspaceDir, script.path);
      await this.backupFile(targetPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, script.content, 'utf-8');
    }
  }

  /**
   * Restore extension configs.
   */
  private async restoreExtensions(extensions: ExtensionEntry[]): Promise<void> {
    for (const ext of extensions) {
      const extDir = join(this.workspaceDir, 'extensions', ext.name);
      await mkdir(extDir, { recursive: true });

      for (const [filename, content] of Object.entries(ext.configs)) {
        const targetPath = join(extDir, filename);
        await this.backupFile(targetPath);
        await writeFile(targetPath, content, 'utf-8');
      }
    }
  }

  /**
   * Restore config files to workspace root.
   */
  private async restoreConfigFiles(configs: Record<string, unknown>): Promise<void> {
    for (const [file, value] of Object.entries(configs)) {
      if (typeof value !== 'string') continue;
      const targetPath = join(this.workspaceDir, file);
      await this.backupFile(targetPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, value, 'utf-8');
    }
  }

  /**
   * Create a .bak backup of an existing file before overwriting.
   */
  private async backupFile(filePath: string): Promise<void> {
    if (existsSync(filePath)) {
      const backupPath = filePath + '.bak';
      try {
        await rename(filePath, backupPath);
      } catch {
        // If rename fails (e.g., permissions), continue without backup
      }
    }
  }
}
