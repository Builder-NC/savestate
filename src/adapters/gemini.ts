/**
 * Google Gemini Adapter
 *
 * Captures Gemini conversations, Gems (custom agents), and API data.
 *
 * Data sources:
 * 1. Google Takeout export — conversations from "Gemini Apps" export
 * 2. Gemini API — tuned models, cached content (requires API key)
 *
 * Environment variables:
 * - SAVESTATE_GEMINI_EXPORT — path to Takeout export directory
 * - GOOGLE_API_KEY or GEMINI_API_KEY — for API-based capture
 *
 * Uses native fetch() — no external dependencies.
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type {
  Adapter,
  PlatformMeta,
  Snapshot,
  MemoryEntry,
  KnowledgeDocument,
  ConversationMeta,
  Conversation,
  Message,
} from '../types.js';
import { SAF_VERSION, generateSnapshotId, computeChecksum } from '../format.js';

// ─── Constants ───────────────────────────────────────────────

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

// ─── Types for Takeout data ─────────────────────────────────

interface TakeoutConversation {
  id?: string;
  title?: string;
  create_time?: string;
  update_time?: string;
  messages?: TakeoutMessage[];
  // Some exports nest under different keys
  [key: string]: unknown;
}

interface TakeoutMessage {
  role?: string;
  text?: string;
  content?: string;
  create_time?: string;
  timestamp?: string;
  metadata?: {
    model_version?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Gem / custom agent data that may appear in Takeout */
interface GemData {
  name: string;
  description?: string;
  instructions?: string;
  system_prompt?: string;
  model?: string;
  [key: string]: unknown;
}

// ─── Types for Gemini API responses ─────────────────────────

interface GeminiTunedModel {
  name: string;
  displayName?: string;
  description?: string;
  state?: string;
  baseModel?: string;
  tunedModelSource?: {
    tunedModel?: string;
    base_model?: string;
  };
  temperature?: number;
  topP?: number;
  topK?: number;
  createTime?: string;
  updateTime?: string;
  tuningTask?: {
    startTime?: string;
    completeTime?: string;
    hyperparameters?: Record<string, unknown>;
    trainingData?: {
      examples?: { examples?: unknown[] };
    };
  };
}

interface GeminiCachedContent {
  name: string;
  displayName?: string;
  model?: string;
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  usageMetadata?: {
    totalTokenCount?: number;
  };
}

interface GeminiListResponse<T> {
  tunedModels?: T[];
  cachedContents?: T[];
  nextPageToken?: string;
}

// ─── Adapter ─────────────────────────────────────────────────

export class GeminiAdapter implements Adapter {
  readonly id = 'gemini';
  readonly name = 'Google Gemini';
  readonly platform = 'gemini';
  readonly version = '0.1.0';

  private warnings: string[] = [];
  private exportDir: string | null = null;
  private apiKey: string | null = null;

  constructor() {
    this.apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? null;
  }

  async detect(): Promise<boolean> {
    // 1. Check env var pointing to Takeout directory
    const envExport = process.env.SAVESTATE_GEMINI_EXPORT;
    if (envExport && existsSync(envExport)) {
      this.exportDir = await this.resolveExportDir(envExport);
      if (this.exportDir) return true;
    }

    // 2. Check for Gemini Apps/ or Takeout/Gemini Apps/ in current directory
    const cwd = process.cwd();
    const localPaths = [
      join(cwd, 'Gemini Apps'),
      join(cwd, 'Takeout', 'Gemini Apps'),
      join(cwd, 'Google Gemini'),
      join(cwd, 'Takeout', 'Google Gemini'),
    ];
    for (const p of localPaths) {
      if (existsSync(p)) {
        this.exportDir = p;
        return true;
      }
    }

    // 3. Check for .savestate/imports/gemini/
    const importDir = join(cwd, '.savestate', 'imports', 'gemini');
    if (existsSync(importDir)) {
      this.exportDir = importDir;
      return true;
    }

    // 4. Check for API key (can capture tuned models and cached content)
    if (this.apiKey) {
      return true;
    }

    return false;
  }

  async extract(): Promise<Snapshot> {
    this.warnings = [];

    // Gather data from both sources
    const conversations = await this.extractConversations();
    const fullConversations = await this.extractFullConversations();
    const gems = await this.extractGems();
    const { tunedModels, cachedContent } = await this.extractApiData();

    // Build personality from Gems
    const personality = this.buildPersonality(gems);

    // Build config from API data + Gems
    const config = this.buildConfig(gems, tunedModels, cachedContent);

    // Build memory entries from conversation metadata
    const memoryEntries: MemoryEntry[] = [];

    // Build knowledge docs
    const knowledge = this.buildKnowledge(fullConversations);

    const snapshotId = generateSnapshotId();
    const now = new Date().toISOString();

    // Summary reporting
    const parts: string[] = [];
    if (conversations.length > 0) parts.push(`${conversations.length} conversations`);
    if (gems.length > 0) parts.push(`${gems.length} gems`);
    if (tunedModels.length > 0) parts.push(`${tunedModels.length} tuned models`);
    if (cachedContent.length > 0) parts.push(`${cachedContent.length} cached contents`);
    if (parts.length > 0) {
      console.log(`  Found ${parts.join(', ')}`);
    }

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
        personality: personality || undefined,
        config: Object.keys(config).length > 0 ? config : undefined,
        tools: [],
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
      restoreHints: this.buildRestoreHints(gems, tunedModels, cachedContent),
    };

    return snapshot;
  }

  async restore(snapshot: Snapshot): Promise<void> {
    const outputDir = join(process.cwd(), '.savestate', 'restore', 'gemini');
    await mkdir(outputDir, { recursive: true });

    const guide = this.generateRestoreGuide(snapshot);
    const guidePath = join(outputDir, 'gemini-restore-guide.md');
    await writeFile(guidePath, guide, 'utf-8');
    console.log(`  📄 Generated restore guide: ${guidePath}`);

    // Restore conversations as individual JSON files
    if (snapshot.conversations.total > 0) {
      const convsDir = join(outputDir, 'conversations');
      await mkdir(convsDir, { recursive: true });

      // Write conversation index
      const indexPath = join(convsDir, 'index.json');
      await writeFile(indexPath, JSON.stringify(snapshot.conversations, null, 2), 'utf-8');
      console.log(`  📋 Restored conversation index (${snapshot.conversations.total} conversations)`);
    }

    // Restore Gem configs
    if (snapshot.identity.config) {
      const gemConfigs = (snapshot.identity.config as Record<string, unknown>).gems;
      if (Array.isArray(gemConfigs) && gemConfigs.length > 0) {
        const gemsDir = join(outputDir, 'gems');
        await mkdir(gemsDir, { recursive: true });

        for (const gem of gemConfigs as GemData[]) {
          const filename = `${gem.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
          await writeFile(join(gemsDir, filename), JSON.stringify(gem, null, 2), 'utf-8');
        }
        console.log(`  💎 Restored ${(gemConfigs as unknown[]).length} Gem configurations`);
      }
    }

    // If API key is available, try to restore cached content
    if (this.apiKey && snapshot.identity.config) {
      const cachedContent = (snapshot.identity.config as Record<string, unknown>).cachedContent;
      if (Array.isArray(cachedContent) && cachedContent.length > 0) {
        console.log(`  📦 Found ${cachedContent.length} cached content entries (API restore not yet supported)`);
        console.log(`     See restore guide for manual steps.`);
      }
    }

    console.log(`\n  📖 Review ${guidePath} for complete restore instructions.`);
  }

  async identify(): Promise<PlatformMeta> {
    const sources: string[] = [];
    if (this.exportDir) sources.push('takeout-export');
    if (this.apiKey) sources.push('api');

    return {
      name: 'Google Gemini',
      version: 'unknown',
      exportMethod: sources.join('+') || 'none',
    };
  }

  // ─── Private: Detection helpers ───────────────────────────

  /**
   * Resolve the Takeout export directory.
   * Handles various nesting patterns.
   */
  private async resolveExportDir(basePath: string): Promise<string | null> {
    // Direct Gemini Apps directory
    if (await this.hasConversations(basePath)) return basePath;

    // Nested under common patterns
    const candidates = [
      join(basePath, 'Gemini Apps'),
      join(basePath, 'Google Gemini'),
      join(basePath, 'Takeout', 'Gemini Apps'),
      join(basePath, 'Takeout', 'Google Gemini'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }

    // Check if basePath itself contains JSON files (flat export)
    try {
      const files = await readdir(basePath);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      if (jsonFiles.length > 0) return basePath;
    } catch {
      // not readable
    }

    return null;
  }

  /**
   * Check if a directory has conversation-like content.
   */
  private async hasConversations(dir: string): Promise<boolean> {
    if (!existsSync(dir)) return false;
    try {
      const entries = await readdir(dir);
      // Check for Conversations/ subdirectory or JSON files
      if (entries.includes('Conversations')) return true;
      return entries.some(e => e.endsWith('.json'));
    } catch {
      return false;
    }
  }

  // ─── Private: Extraction ──────────────────────────────────

  /**
   * Extract conversation metadata from Takeout export.
   */
  private async extractConversations(): Promise<ConversationMeta[]> {
    if (!this.exportDir) return [];

    const jsonFiles = await this.findConversationFiles();
    const conversations: ConversationMeta[] = [];

    for (const filePath of jsonFiles) {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const data = JSON.parse(raw) as TakeoutConversation;

        const id = data.id ?? basename(filePath, '.json');
        const title = data.title ?? this.inferTitle(data);
        const messages = this.extractMessages(data);
        const createdAt = data.create_time ?? this.inferTimestamp(filePath) ?? new Date().toISOString();
        const updatedAt = data.update_time ?? (messages.length > 0 ? messages[messages.length - 1].timestamp : createdAt);

        conversations.push({
          id,
          title,
          createdAt,
          updatedAt,
          messageCount: messages.length,
          path: `conversations/gemini/${basename(filePath)}`,
        });
      } catch (err) {
        this.warnings.push(`Failed to parse conversation: ${basename(filePath)} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return conversations;
  }

  /**
   * Extract full conversations for knowledge indexing.
   */
  private async extractFullConversations(): Promise<Conversation[]> {
    if (!this.exportDir) return [];

    const jsonFiles = await this.findConversationFiles();
    const conversations: Conversation[] = [];

    for (const filePath of jsonFiles) {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const data = JSON.parse(raw) as TakeoutConversation;

        const id = data.id ?? basename(filePath, '.json');
        const title = data.title ?? this.inferTitle(data);
        const messages = this.extractMessages(data);
        const createdAt = data.create_time ?? this.inferTimestamp(filePath) ?? new Date().toISOString();
        const updatedAt = data.update_time ?? (messages.length > 0 ? messages[messages.length - 1].timestamp : createdAt);

        conversations.push({
          id,
          title,
          createdAt,
          updatedAt,
          messages,
          metadata: {
            source: 'takeout',
            filename: basename(filePath),
          },
        });
      } catch {
        // Already warned in extractConversations
      }
    }

    return conversations;
  }

  /**
   * Find all conversation JSON files in the export directory.
   */
  private async findConversationFiles(): Promise<string[]> {
    if (!this.exportDir) return [];

    const jsonFiles: string[] = [];

    // Check Conversations/ subdirectory
    const convsDir = join(this.exportDir, 'Conversations');
    if (existsSync(convsDir)) {
      await this.collectJsonFiles(convsDir, jsonFiles);
    }

    // Also check root of export dir for JSON files
    await this.collectJsonFiles(this.exportDir, jsonFiles, false);

    // Deduplicate by absolute path
    return [...new Set(jsonFiles)];
  }

  /**
   * Collect JSON files from a directory.
   */
  private async collectJsonFiles(dir: string, results: string[], recursive = true): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith('.json')) {
          // Skip non-conversation JSON files
          if (entry.name === 'index.json' || entry.name === 'gems.json') continue;
          results.push(fullPath);
        } else if (recursive && entry.isDirectory() && entry.name !== 'Gems') {
          await this.collectJsonFiles(fullPath, results, recursive);
        }
      }
    } catch {
      // directory not readable
    }
  }

  /**
   * Extract messages from a Takeout conversation, handling format variations.
   */
  private extractMessages(data: TakeoutConversation): Message[] {
    const messages: Message[] = [];

    // Try standard "messages" field
    let rawMessages: TakeoutMessage[] | undefined = data.messages as TakeoutMessage[] | undefined;

    // Try alternative field names
    if (!rawMessages || !Array.isArray(rawMessages)) {
      rawMessages = (data.conversation_messages ?? data.entries ?? data.turns) as TakeoutMessage[] | undefined;
    }

    if (!rawMessages || !Array.isArray(rawMessages)) return messages;

    for (let i = 0; i < rawMessages.length; i++) {
      const msg = rawMessages[i];

      // Extract role — map Gemini's "model" to SaveState's "assistant"
      let role: Message['role'] = 'user';
      const rawRole = (msg.role ?? msg.author ?? '') as string;
      if (rawRole === 'model' || rawRole === 'assistant' || rawRole === 'MODEL' || rawRole === 'ASSISTANT') {
        role = 'assistant';
      } else if (rawRole === 'system' || rawRole === 'SYSTEM') {
        role = 'system';
      } else if (rawRole === 'tool' || rawRole === 'function' || rawRole === 'TOOL') {
        role = 'tool';
      }

      // Extract content — try multiple field names
      const content = (msg.text ?? msg.content ?? msg.parts ?? '') as string;
      if (!content && typeof content !== 'string') continue;

      // Handle parts array (Gemini sometimes uses parts: [{text: "..."}])
      let textContent: string;
      if (Array.isArray(content)) {
        textContent = content
          .map((p: unknown) => {
            if (typeof p === 'string') return p;
            if (p && typeof p === 'object' && 'text' in p) return (p as { text: string }).text;
            return '';
          })
          .filter(Boolean)
          .join('\n');
      } else {
        textContent = String(content);
      }

      if (!textContent) continue;

      // Extract timestamp
      const timestamp = msg.create_time ?? msg.timestamp ?? msg.created_at ?? new Date().toISOString();

      // Build metadata
      const metadata: Record<string, unknown> = {};
      if (msg.metadata?.model_version) {
        metadata.model = msg.metadata.model_version;
      }

      messages.push({
        id: `msg-${i}`,
        role,
        content: textContent,
        timestamp: String(timestamp),
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }

    return messages;
  }

  /**
   * Extract Gem (custom agent) configurations from export.
   */
  private async extractGems(): Promise<GemData[]> {
    if (!this.exportDir) return [];

    const gems: GemData[] = [];

    // Check for gems.json in export directory
    const gemsFiles = [
      join(this.exportDir, 'gems.json'),
      join(this.exportDir, 'Gems', 'gems.json'),
      join(this.exportDir, 'Gems.json'),
    ];

    for (const gemFile of gemsFiles) {
      if (existsSync(gemFile)) {
        try {
          const raw = await readFile(gemFile, 'utf-8');
          const data = JSON.parse(raw);
          if (Array.isArray(data)) {
            gems.push(...(data as GemData[]));
          } else if (data.gems && Array.isArray(data.gems)) {
            gems.push(...(data.gems as GemData[]));
          }
        } catch (err) {
          this.warnings.push(`Failed to parse gems file: ${basename(gemFile)} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Check for individual gem JSON files in a Gems/ directory
    const gemsDir = join(this.exportDir, 'Gems');
    if (existsSync(gemsDir)) {
      try {
        const files = await readdir(gemsDir);
        for (const file of files) {
          if (!file.endsWith('.json') || file === 'gems.json') continue;
          try {
            const raw = await readFile(join(gemsDir, file), 'utf-8');
            const gem = JSON.parse(raw) as GemData;
            if (gem.name || gem.instructions || gem.system_prompt) {
              gems.push(gem);
            }
          } catch {
            this.warnings.push(`Failed to parse gem file: ${file}`);
          }
        }
      } catch {
        // Gems directory not readable
      }
    }

    return gems;
  }

  /**
   * Extract data from Gemini API (tuned models, cached content).
   */
  private async extractApiData(): Promise<{
    tunedModels: GeminiTunedModel[];
    cachedContent: GeminiCachedContent[];
  }> {
    if (!this.apiKey) {
      return { tunedModels: [], cachedContent: [] };
    }

    const tunedModels = await this.fetchTunedModels();
    const cachedContent = await this.fetchCachedContent();

    return { tunedModels, cachedContent };
  }

  /**
   * Fetch tuned models from the Gemini API.
   */
  private async fetchTunedModels(): Promise<GeminiTunedModel[]> {
    const models: GeminiTunedModel[] = [];
    let pageToken: string | undefined;

    try {
      do {
        const url = new URL(`${GEMINI_API_BASE}/v1beta/tunedModels`);
        url.searchParams.set('key', this.apiKey!);
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const data = await this.apiFetch<GeminiListResponse<GeminiTunedModel>>(url.toString());
        if (data?.tunedModels) {
          models.push(...data.tunedModels);
        }
        pageToken = data?.nextPageToken;
      } while (pageToken);
    } catch (err) {
      this.warnings.push(`Failed to fetch tuned models: ${err instanceof Error ? err.message : String(err)}`);
    }

    return models;
  }

  /**
   * Fetch cached content from the Gemini API.
   */
  private async fetchCachedContent(): Promise<GeminiCachedContent[]> {
    const contents: GeminiCachedContent[] = [];
    let pageToken: string | undefined;

    try {
      do {
        const url = new URL(`${GEMINI_API_BASE}/v1beta/cachedContents`);
        url.searchParams.set('key', this.apiKey!);
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const data = await this.apiFetch<GeminiListResponse<GeminiCachedContent>>(url.toString());
        if (data?.cachedContents) {
          contents.push(...data.cachedContents);
        }
        pageToken = data?.nextPageToken;
      } while (pageToken);
    } catch (err) {
      this.warnings.push(`Failed to fetch cached content: ${err instanceof Error ? err.message : String(err)}`);
    }

    return contents;
  }

  // ─── Private: Building snapshot components ────────────────

  /**
   * Build personality string from Gem configurations.
   */
  private buildPersonality(gems: GemData[]): string {
    if (gems.length === 0) return '';

    const parts: string[] = [];
    for (const gem of gems) {
      const instruction = gem.instructions ?? gem.system_prompt ?? '';
      if (!instruction && !gem.description) continue;

      const header = `--- Gem: ${gem.name} ---`;
      const desc = gem.description ? `Description: ${gem.description}\n` : '';
      const model = gem.model ? `Model: ${gem.model}\n` : '';
      const body = instruction ? `\n${instruction}` : '';

      parts.push(`${header}\n${desc}${model}${body}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Build config object from gems, tuned models, and cached content.
   */
  private buildConfig(
    gems: GemData[],
    tunedModels: GeminiTunedModel[],
    cachedContent: GeminiCachedContent[],
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {};

    if (gems.length > 0) {
      config.gems = gems;
    }

    if (tunedModels.length > 0) {
      config.tunedModels = tunedModels.map(m => ({
        name: m.name,
        displayName: m.displayName,
        description: m.description,
        state: m.state,
        baseModel: m.baseModel,
        temperature: m.temperature,
        topP: m.topP,
        topK: m.topK,
        createTime: m.createTime,
        updateTime: m.updateTime,
        hyperparameters: m.tuningTask?.hyperparameters,
      }));
    }

    if (cachedContent.length > 0) {
      config.cachedContent = cachedContent.map(c => ({
        name: c.name,
        displayName: c.displayName,
        model: c.model,
        createTime: c.createTime,
        updateTime: c.updateTime,
        expireTime: c.expireTime,
        totalTokenCount: c.usageMetadata?.totalTokenCount,
      }));
    }

    // Note data source info
    config._dataSources = {
      takeoutExport: !!this.exportDir,
      apiKey: !!this.apiKey,
      exportDir: this.exportDir ?? undefined,
    };

    return config;
  }

  /**
   * Build knowledge documents from conversations.
   */
  private buildKnowledge(conversations: Conversation[]): KnowledgeDocument[] {
    const docs: KnowledgeDocument[] = [];

    for (const conv of conversations) {
      const content = JSON.stringify(conv, null, 2);
      const buf = Buffer.from(content, 'utf-8');

      docs.push({
        id: `conversation:${conv.id}`,
        filename: `conversations/gemini/${conv.id}.json`,
        mimeType: 'application/json',
        path: `knowledge/conversations/gemini/${conv.id}.json`,
        size: buf.length,
        checksum: computeChecksum(buf),
      });
    }

    return docs;
  }

  /**
   * Build restore hints based on available data.
   */
  private buildRestoreHints(
    gems: GemData[],
    tunedModels: GeminiTunedModel[],
    cachedContent: GeminiCachedContent[],
  ): Snapshot['restoreHints'] {
    const steps: Snapshot['restoreHints']['steps'] = [];
    const manualSteps: string[] = [];

    // Always generate the restore guide
    steps.push({
      type: 'file',
      description: 'Generate gemini-restore-guide.md with organized data for manual import',
      target: '.savestate/restore/gemini/',
    });

    if (gems.length > 0) {
      steps.push({
        type: 'manual',
        description: `Recreate ${gems.length} Gem(s) in Google Gemini with saved instructions`,
        target: 'https://gemini.google.com/gems',
      });
      manualSteps.push(
        'Open https://gemini.google.com/gems and manually recreate each Gem',
        'Gem instructions are saved in the restore guide and individual JSON files',
      );
    }

    if (tunedModels.length > 0) {
      manualSteps.push(
        `${tunedModels.length} tuned model(s) detected — configurations saved but training data must be re-supplied`,
        'Use Google AI Studio (aistudio.google.com) or the Gemini API to recreate tuned models',
      );
    }

    if (cachedContent.length > 0) {
      if (this.apiKey) {
        steps.push({
          type: 'api',
          description: `Restore ${cachedContent.length} cached content entry/entries via Gemini API`,
          target: 'generativelanguage.googleapis.com/v1beta/cachedContents',
        });
      }
      manualSteps.push(
        'Cached content configurations saved — content itself must be re-uploaded',
      );
    }

    manualSteps.push(
      'Gemini conversations are read-only exports — they cannot be re-imported',
      'Review gemini-restore-guide.md for complete instructions',
    );

    return {
      platform: 'gemini',
      steps,
      manualSteps,
    };
  }

  // ─── Private: Restore helpers ─────────────────────────────

  /**
   * Generate a comprehensive restore guide.
   */
  private generateRestoreGuide(snapshot: Snapshot): string {
    const lines: string[] = [];

    lines.push('# Gemini Restore Guide');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Snapshot: ${snapshot.manifest.id}`);
    lines.push(`Platform: ${snapshot.platform.name}`);
    lines.push(`Export method: ${snapshot.platform.exportMethod}`);
    lines.push('');

    // Gems section
    const gems = (snapshot.identity.config as Record<string, unknown> | undefined)?.gems as GemData[] | undefined;
    if (gems && gems.length > 0) {
      lines.push('## 💎 Gems (Custom Agents)');
      lines.push('');
      lines.push('To restore your Gems, go to https://gemini.google.com/gems and create each one:');
      lines.push('');

      for (const gem of gems) {
        lines.push(`### ${gem.name}`);
        if (gem.description) lines.push(`**Description:** ${gem.description}`);
        if (gem.model) lines.push(`**Model:** ${gem.model}`);
        lines.push('');
        const instructions = gem.instructions ?? gem.system_prompt;
        if (instructions) {
          lines.push('**Instructions:**');
          lines.push('```');
          lines.push(instructions);
          lines.push('```');
          lines.push('');
        }
      }
    }

    // Conversations section
    if (snapshot.conversations.total > 0) {
      lines.push('## 💬 Conversations');
      lines.push('');
      lines.push(`Total: ${snapshot.conversations.total} conversations`);
      lines.push('');
      lines.push('> Note: Gemini conversations cannot be re-imported. They are preserved here as a record.');
      lines.push('');

      for (const conv of snapshot.conversations.conversations.slice(0, 50)) {
        const date = conv.createdAt.split('T')[0];
        lines.push(`- **${conv.title ?? conv.id}** (${date}) — ${conv.messageCount} messages`);
      }
      if (snapshot.conversations.total > 50) {
        lines.push(`- ... and ${snapshot.conversations.total - 50} more`);
      }
      lines.push('');
    }

    // Tuned models section
    const tunedModels = (snapshot.identity.config as Record<string, unknown> | undefined)?.tunedModels as Record<string, unknown>[] | undefined;
    if (tunedModels && tunedModels.length > 0) {
      lines.push('## 🧪 Tuned Models');
      lines.push('');
      lines.push('To recreate tuned models, use Google AI Studio (aistudio.google.com) or the Gemini API.');
      lines.push('');

      for (const model of tunedModels) {
        lines.push(`### ${(model.displayName as string) ?? (model.name as string)}`);
        if (model.description) lines.push(`**Description:** ${model.description}`);
        if (model.baseModel) lines.push(`**Base Model:** ${model.baseModel}`);
        if (model.state) lines.push(`**State:** ${model.state}`);
        if (model.temperature !== undefined) lines.push(`**Temperature:** ${model.temperature}`);
        if (model.hyperparameters) {
          lines.push(`**Hyperparameters:** \`${JSON.stringify(model.hyperparameters)}\``);
        }
        lines.push('');
      }
    }

    // Cached content section
    const cachedContent = (snapshot.identity.config as Record<string, unknown> | undefined)?.cachedContent as Record<string, unknown>[] | undefined;
    if (cachedContent && cachedContent.length > 0) {
      lines.push('## 📦 Cached Content');
      lines.push('');
      lines.push('Cached content entries (content must be re-uploaded):');
      lines.push('');

      for (const entry of cachedContent) {
        lines.push(`- **${(entry.displayName as string) ?? (entry.name as string)}** — Model: ${entry.model ?? 'unknown'}, Tokens: ${entry.totalTokenCount ?? 'unknown'}`);
      }
      lines.push('');
    }

    // Manual steps
    if (snapshot.restoreHints.manualSteps && snapshot.restoreHints.manualSteps.length > 0) {
      lines.push('## 📋 Manual Steps Required');
      lines.push('');
      for (const step of snapshot.restoreHints.manualSteps) {
        lines.push(`- [ ] ${step}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ─── Private: Utility ─────────────────────────────────────

  /**
   * Infer a title from the conversation data when title field is missing.
   */
  private inferTitle(data: TakeoutConversation): string {
    // Try to get the first user message as a title
    const messages = (data.messages ?? data.conversation_messages ?? data.entries ?? data.turns) as TakeoutMessage[] | undefined;
    if (messages && Array.isArray(messages) && messages.length > 0) {
      const firstMsg = messages[0];
      const text = (firstMsg.text ?? firstMsg.content ?? '') as string;
      if (typeof text === 'string' && text.length > 0) {
        return text.length > 80 ? text.slice(0, 77) + '...' : text;
      }
    }
    return 'Untitled Conversation';
  }

  /**
   * Infer a timestamp from a filename like "2025-01-15T10_30_00-conversation.json".
   */
  private inferTimestamp(filePath: string): string | null {
    const name = basename(filePath, '.json');
    // Match ISO-like timestamp with underscores instead of colons
    const match = name.match(/(\d{4}-\d{2}-\d{2}T\d{2}[_:]\d{2}[_:]\d{2})/);
    if (match) {
      return match[1].replace(/_/g, ':') + 'Z';
    }
    return null;
  }

  /**
   * Make an API request with retries and exponential backoff.
   */
  private async apiFetch<T>(url: string, options?: RequestInit): Promise<T | null> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...options?.headers,
          },
        });

        if (response.status === 429) {
          // Rate limited — backoff and retry
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
        }

        return (await response.json()) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES - 1) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }

    throw lastError ?? new Error('API request failed after retries');
  }
}
