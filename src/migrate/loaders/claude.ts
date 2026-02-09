/**
 * Claude Loader
 *
 * Loads migration data into Claude Projects.
 *
 * Target Structure:
 * - Claude Project with custom name
 * - System prompt from transformed instructions
 * - Project knowledge documents (memories, context)
 * - Uploaded files
 *
 * @see https://docs.anthropic.com/claude/reference/projects
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type {
  Platform,
  Loader,
  LoadOptions,
  LoadResult,
  MigrationBundle,
  FileEntry,
} from '../types.js';
import { getPlatformCapabilities } from '../capabilities.js';

// ─── API Types ───────────────────────────────────────────────

interface ClaudeProject {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  archived_at?: string;
}

interface ClaudeProjectDocument {
  id: string;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface ClaudeProjectFile {
  id: string;
  name: string;
  content_type: string;
  size: number;
  created_at: string;
}

interface ApiError extends Error {
  status?: number;
  code?: string;
  retryAfter?: number;
}

// ─── Configuration ───────────────────────────────────────────

export interface ClaudeLoaderConfig {
  /** Anthropic API key */
  apiKey?: string;
  /** API base URL (defaults to https://api.anthropic.com) */
  baseUrl?: string;
  /** Max retries for failed requests */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms) */
  retryDelayMs?: number;
  /** Organization ID (if applicable) */
  organizationId?: string;
}

// ─── Rate Limiter ────────────────────────────────────────────

class RateLimiter {
  private requestTimes: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests = 50, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter((t) => now - t < this.windowMs);

    if (this.requestTimes.length >= this.maxRequests) {
      const oldestRequest = this.requestTimes[0];
      const waitTime = this.windowMs - (now - oldestRequest) + 100;
      await this.sleep(waitTime);
    }

    this.requestTimes.push(Date.now());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── Claude API Client ───────────────────────────────────────

class ClaudeApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly rateLimiter: RateLimiter;
  private readonly organizationId?: string;

  constructor(config: ClaudeLoaderConfig) {
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.rateLimiter = new RateLimiter();
    this.organizationId = config.organizationId;
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retryCount = 0,
  ): Promise<T> {
    await this.rateLimiter.acquire();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2024-10-01',
      'x-api-key': this.apiKey,
    };

    if (this.organizationId) {
      headers['anthropic-organization'] = this.organizationId;
    }

    const url = `${this.baseUrl}${path}`;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const error = new Error() as ApiError;
        error.status = response.status;

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          error.retryAfter = retryAfter ? parseInt(retryAfter, 10) * 1000 : this.retryDelayMs;
          error.code = 'rate_limit_exceeded';
          error.message = 'Rate limit exceeded';

          if (retryCount < this.maxRetries) {
            await this.sleep(error.retryAfter);
            return this.request<T>(method, path, body, retryCount + 1);
          }
        }

        // Handle transient errors
        if (response.status >= 500 && retryCount < this.maxRetries) {
          await this.sleep(this.retryDelayMs * Math.pow(2, retryCount));
          return this.request<T>(method, path, body, retryCount + 1);
        }

        try {
          const errorBody = (await response.json()) as { error?: { message?: string; type?: string } };
          error.message = errorBody.error?.message || `API error: ${response.status}`;
          error.code = errorBody.error?.type;
        } catch {
          error.message = `API error: ${response.status} ${response.statusText}`;
        }

        throw error;
      }

      return response.json() as Promise<T>;
    } catch (err) {
      // Retry on network errors
      if (
        err instanceof TypeError &&
        err.message.includes('fetch') &&
        retryCount < this.maxRetries
      ) {
        await this.sleep(this.retryDelayMs * Math.pow(2, retryCount));
        return this.request<T>(method, path, body, retryCount + 1);
      }
      throw err;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Projects API ────────────────────────────────────────

  async createProject(name: string, description?: string): Promise<ClaudeProject> {
    return this.request<ClaudeProject>('POST', '/v1/projects', {
      name,
      description,
    });
  }

  async updateProjectPrompt(projectId: string, systemPrompt: string): Promise<void> {
    await this.request('PUT', `/v1/projects/${projectId}`, {
      prompt_template: systemPrompt,
    });
  }

  async createProjectDocument(
    projectId: string,
    name: string,
    content: string,
  ): Promise<ClaudeProjectDocument> {
    return this.request<ClaudeProjectDocument>('POST', `/v1/projects/${projectId}/docs`, {
      name,
      content,
    });
  }

  async uploadProjectFile(
    projectId: string,
    filename: string,
    content: Buffer,
    contentType: string,
  ): Promise<ClaudeProjectFile> {
    await this.rateLimiter.acquire();

    const formData = new FormData();
    formData.append('file', new Blob([content], { type: contentType }), filename);

    const headers: Record<string, string> = {
      'anthropic-version': '2024-10-01',
      'x-api-key': this.apiKey,
    };

    if (this.organizationId) {
      headers['anthropic-organization'] = this.organizationId;
    }

    const response = await fetch(`${this.baseUrl}/v1/projects/${projectId}/files`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      const error = new Error() as ApiError;
      error.status = response.status;

      try {
        const errorBody = (await response.json()) as { error?: { message?: string } };
        error.message = errorBody.error?.message || `File upload error: ${response.status}`;
      } catch {
        error.message = `File upload error: ${response.status}`;
      }

      throw error;
    }

    return response.json() as Promise<ClaudeProjectFile>;
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.request('DELETE', `/v1/projects/${projectId}`);
  }
}

// ─── Load State (for resume capability) ──────────────────────

interface ClaudeLoadState {
  projectId?: string;
  instructionsLoaded: boolean;
  memoriesDocId?: string;
  contextDocId?: string;
  uploadedFileIds: string[];
  uploadedFilenames: string[];
  lastFileIndex: number;
}

// ─── Claude Loader ───────────────────────────────────────────

export class ClaudeLoader implements Loader {
  readonly platform: Platform = 'claude';
  readonly version = '1.0.0';

  private progress = 0;
  private config: ClaudeLoaderConfig;
  private client: ClaudeApiClient;
  private state: ClaudeLoadState = {
    instructionsLoaded: false,
    uploadedFileIds: [],
    uploadedFilenames: [],
    lastFileIndex: -1,
  };

  constructor(config: ClaudeLoaderConfig = {}) {
    this.config = config;
    this.client = new ClaudeApiClient(config);
  }

  async canLoad(): Promise<boolean> {
    return this.client.hasApiKey();
  }

  async load(bundle: MigrationBundle, options: LoadOptions): Promise<LoadResult> {
    this.progress = 0;
    const warnings: string[] = [];
    const errors: string[] = [];
    const capabilities = getPlatformCapabilities('claude');

    // Validate bundle target
    if (bundle.target?.platform !== 'claude') {
      throw new Error('Bundle not transformed for Claude');
    }

    // Check for dry run
    if (options.dryRun) {
      return this.dryRunResult(bundle, warnings);
    }

    try {
      // Step 1: Create Project (10%)
      options.onProgress?.(0.05, 'Creating Claude project...');
      const projectName =
        options.projectName || `Migrated from ${bundle.source.platform} (${new Date().toISOString().split('T')[0]})`;

      const project = await this.client.createProject(
        projectName,
        `Migration from ${bundle.source.platform} via SaveState`,
      );
      this.state.projectId = project.id;
      this.progress = 10;
      options.onProgress?.(0.1, `Created project: ${projectName}`);

      // Step 2: Set System Prompt (20%)
      let instructionsLoaded = false;
      if (bundle.contents.instructions?.content) {
        options.onProgress?.(0.15, 'Setting system prompt...');
        const instructionContent = bundle.contents.instructions.content;

        // Check length limit
        if (instructionContent.length > capabilities.instructionLimit) {
          warnings.push(
            `Instructions truncated: ${instructionContent.length} > ${capabilities.instructionLimit} chars`,
          );
        }

        const truncatedInstructions = instructionContent.slice(0, capabilities.instructionLimit);
        await this.client.updateProjectPrompt(project.id, truncatedInstructions);
        this.state.instructionsLoaded = true;
        instructionsLoaded = true;
      }
      this.progress = 20;
      options.onProgress?.(0.2, 'System prompt configured');

      // Step 3: Upload Knowledge Documents (40%)
      let memoriesLoaded = 0;
      if (bundle.contents.memories?.entries && bundle.contents.memories.entries.length > 0) {
        options.onProgress?.(0.25, 'Creating memories document...');

        const memoriesContent = this.formatMemoriesAsMarkdown(bundle.contents.memories.entries);
        const memoriesDoc = await this.client.createProjectDocument(
          project.id,
          'memories.md',
          memoriesContent,
        );
        this.state.memoriesDocId = memoriesDoc.id;
        memoriesLoaded = bundle.contents.memories.entries.length;
      }

      // Create context summary if available
      if (bundle.contents.conversations?.summaries && bundle.contents.conversations.summaries.length > 0) {
        options.onProgress?.(0.35, 'Creating context summary...');

        const contextContent = this.formatContextSummary(bundle.contents.conversations.summaries);
        const contextDoc = await this.client.createProjectDocument(
          project.id,
          'context-summary.md',
          contextContent,
        );
        this.state.contextDocId = contextDoc.id;
      }
      this.progress = 40;
      options.onProgress?.(0.4, 'Knowledge documents uploaded');

      // Step 4: Upload Files (40-90%)
      let filesLoaded = 0;
      if (bundle.contents.files?.files && bundle.contents.files.files.length > 0) {
        const files = bundle.contents.files.files;
        const startIndex = this.state.lastFileIndex + 1;

        for (let i = startIndex; i < files.length; i++) {
          const file = files[i];
          const fileProgress = 0.4 + (0.5 * (i + 1)) / files.length;
          options.onProgress?.(fileProgress, `Uploading file ${i + 1}/${files.length}: ${file.filename}`);

          try {
            const uploadResult = await this.uploadFile(project.id, file, bundle, capabilities.fileSizeLimit!);
            if (uploadResult.success) {
              this.state.uploadedFileIds.push(uploadResult.fileId!);
              this.state.uploadedFilenames.push(file.filename);
              this.state.lastFileIndex = i;
              filesLoaded++;
            } else if (uploadResult.warning) {
              warnings.push(uploadResult.warning);
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            errors.push(`Failed to upload ${file.filename}: ${errorMsg}`);
          }
        }
      }
      this.progress = 90;

      // Step 5: Finalize (100%)
      options.onProgress?.(0.95, 'Finalizing migration...');
      this.progress = 100;
      options.onProgress?.(1.0, 'Migration complete');

      const manualSteps: string[] = [];
      if (bundle.contents.customBots && bundle.contents.customBots.count > 0) {
        manualSteps.push(
          `${bundle.contents.customBots.count} custom bots/GPTs were found but cannot be automatically migrated. You may want to recreate them manually.`,
        );
      }

      return {
        success: true,
        loaded: {
          instructions: instructionsLoaded,
          memories: memoriesLoaded,
          files: filesLoaded,
          customBots: 0, // Claude doesn't have custom bots
        },
        created: {
          projectId: project.id,
          projectUrl: `https://claude.ai/project/${project.id}`,
        },
        warnings,
        errors,
        manualSteps: manualSteps.length > 0 ? manualSteps : undefined,
      };
    } catch (err) {
      // Attempt partial recovery info
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push(`Load failed: ${errorMsg}`);

      return {
        success: false,
        loaded: {
          instructions: this.state.instructionsLoaded,
          memories: this.state.memoriesDocId ? 1 : 0,
          files: this.state.uploadedFileIds.length,
          customBots: 0,
        },
        created: this.state.projectId
          ? {
              projectId: this.state.projectId,
              projectUrl: `https://claude.ai/project/${this.state.projectId}`,
            }
          : undefined,
        warnings,
        errors,
      };
    }
  }

  getProgress(): number {
    return this.progress;
  }

  /**
   * Get current load state for checkpointing.
   */
  getLoadState(): ClaudeLoadState {
    return { ...this.state };
  }

  /**
   * Set load state for resume.
   */
  setLoadState(state: ClaudeLoadState): void {
    this.state = { ...state };
  }

  // ─── Private Helpers ─────────────────────────────────────

  private formatMemoriesAsMarkdown(
    entries: Array<{ id: string; content: string; createdAt: string; category?: string }>,
  ): string {
    const lines = [
      '# Migrated Memories',
      '',
      `> These memories were migrated from your previous AI assistant.`,
      `> Total: ${entries.length} memories`,
      '',
    ];

    // Group by category if available
    const byCategory = new Map<string, typeof entries>();
    for (const entry of entries) {
      const category = entry.category || 'General';
      if (!byCategory.has(category)) {
        byCategory.set(category, []);
      }
      byCategory.get(category)!.push(entry);
    }

    for (const [category, items] of byCategory) {
      lines.push(`## ${category}`, '');
      for (const item of items) {
        lines.push(`- ${item.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatContextSummary(
    summaries: Array<{ id: string; title: string; keyPoints?: string[] }>,
  ): string {
    const lines = [
      '# Conversation Context Summary',
      '',
      `> Key insights extracted from ${summaries.length} conversations.`,
      '',
    ];

    for (const summary of summaries) {
      if (summary.keyPoints && summary.keyPoints.length > 0) {
        lines.push(`## ${summary.title}`, '');
        for (const point of summary.keyPoints) {
          lines.push(`- ${point}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private async uploadFile(
    projectId: string,
    file: FileEntry,
    bundle: MigrationBundle,
    sizeLimit: number,
  ): Promise<{ success: boolean; fileId?: string; warning?: string }> {
    // Check file size
    if (file.size > sizeLimit) {
      return {
        success: false,
        warning: `File ${file.filename} exceeds size limit (${file.size} > ${sizeLimit} bytes)`,
      };
    }

    // Read file content
    const filePath = file.path;
    if (!existsSync(filePath)) {
      return {
        success: false,
        warning: `File not found: ${filePath}`,
      };
    }

    const content = await readFile(filePath);
    const result = await this.client.uploadProjectFile(
      projectId,
      basename(file.filename),
      content,
      file.mimeType,
    );

    return { success: true, fileId: result.id };
  }

  private dryRunResult(bundle: MigrationBundle, warnings: string[]): LoadResult {
    const capabilities = getPlatformCapabilities('claude');

    // Check for potential issues
    if (
      bundle.contents.instructions?.content &&
      bundle.contents.instructions.content.length > capabilities.instructionLimit
    ) {
      warnings.push(
        `Instructions would be truncated: ${bundle.contents.instructions.content.length} > ${capabilities.instructionLimit} chars`,
      );
    }

    if (bundle.contents.files?.files) {
      for (const file of bundle.contents.files.files) {
        if (file.size > capabilities.fileSizeLimit!) {
          warnings.push(`File ${file.filename} exceeds size limit`);
        }
      }
    }

    warnings.push('Dry run - no changes made');

    return {
      success: true,
      loaded: {
        instructions: !!bundle.contents.instructions,
        memories: bundle.contents.memories?.count ?? 0,
        files: bundle.contents.files?.count ?? 0,
        customBots: 0,
      },
      warnings,
      errors: [],
    };
  }
}
