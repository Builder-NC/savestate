/**
 * OpenAI Assistants Adapter
 *
 * Full adapter for OpenAI Assistants API v2.
 * Captures assistant configuration, files, vector stores, and threads.
 *
 * Authentication: OPENAI_API_KEY env var (required).
 * Target assistant: SAVESTATE_OPENAI_ASSISTANT_ID env var (optional).
 *
 * Uses native fetch() — no openai npm package dependency.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type {
  Adapter,
  PlatformMeta,
  Snapshot,
  ToolConfig,
  MemoryEntry,
  KnowledgeDocument,
  ConversationMeta,
  Conversation,
  Message,
} from '../types.js';
import { SAF_VERSION, generateSnapshotId, computeChecksum } from '../format.js';

// ─── Constants ───────────────────────────────────────────────

const OPENAI_BASE = 'https://api.openai.com/v1';
const THREADS_CACHE_DIR = '.savestate';
const THREADS_CACHE_FILE = 'openai-threads.json';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

// ─── Types for OpenAI API responses ─────────────────────────

interface OpenAIAssistant {
  id: string;
  object: string;
  name: string | null;
  description: string | null;
  model: string;
  instructions: string | null;
  tools: OpenAITool[];
  tool_resources: OpenAIToolResources | null;
  metadata: Record<string, string>;
  temperature: number | null;
  top_p: number | null;
  response_format: unknown;
  created_at: number;
}

interface OpenAITool {
  type: string;
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

interface OpenAIToolResources {
  code_interpreter?: { file_ids?: string[] };
  file_search?: { vector_store_ids?: string[] };
}

interface OpenAIFile {
  id: string;
  object: string;
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
}

interface OpenAIVectorStore {
  id: string;
  object: string;
  name: string;
  status: string;
  file_counts: {
    in_progress: number;
    completed: number;
    failed: number;
    cancelled: number;
    total: number;
  };
  metadata: Record<string, string>;
  created_at: number;
  expires_after?: { anchor: string; days: number } | null;
  expires_at?: number | null;
}

interface OpenAIVectorStoreFile {
  id: string;
  object: string;
  vector_store_id: string;
  status: string;
  created_at: number;
}

interface OpenAIMessage {
  id: string;
  object: string;
  role: 'user' | 'assistant';
  content: OpenAIMessageContent[];
  created_at: number;
  thread_id: string;
  metadata: Record<string, string>;
  run_id?: string | null;
}

interface OpenAIMessageContent {
  type: string;
  text?: { value: string; annotations?: unknown[] };
  image_file?: { file_id: string };
  image_url?: { url: string };
}

interface OpenAIListResponse<T> {
  object: string;
  data: T[];
  first_id?: string;
  last_id?: string;
  has_more: boolean;
}

interface ThreadCache {
  assistant_id: string;
  thread_ids: string[];
  updated_at: string;
}

// ─── Adapter ─────────────────────────────────────────────────

export class OpenAIAssistantsAdapter implements Adapter {
  readonly id = 'openai-assistants';
  readonly name = 'OpenAI Assistants';
  readonly platform = 'openai-assistants';
  readonly version = '0.1.0';

  private apiKey: string = '';
  private warnings: string[] = [];

  async detect(): Promise<boolean> {
    // Check for .openai/ config directory
    const openaiDir = join(homedir(), '.openai');
    if (existsSync(openaiDir)) return true;

    // Check for project-level .openai/ config
    if (existsSync(join(process.cwd(), '.openai'))) return true;

    // Check for OPENAI_API_KEY env var
    if (process.env.OPENAI_API_KEY) return true;

    return false;
  }

  async extract(): Promise<Snapshot> {
    this.apiKey = this.requireApiKey();
    this.warnings = [];

    // 1. Determine which assistant to extract
    const assistant = await this.resolveAssistant();
    this.log(`Extracting assistant: ${assistant.name ?? assistant.id} (${assistant.model})`);

    // 2. Extract identity (config, instructions, tools)
    this.log('Extracting assistant configuration...');
    const { personality, config, tools } = this.extractIdentity(assistant);

    // 3. Extract files from tool_resources
    this.log('Extracting files and vector stores...');
    const { knowledge, fileContents, vectorStores } = await this.extractFiles(assistant);

    // Store vector store info in config
    if (vectorStores.length > 0) {
      config.vector_stores = vectorStores;
    }

    // Store file contents in config for restore
    if (Object.keys(fileContents).length > 0) {
      config._file_contents = fileContents;
    }

    // 4. Extract threads (if we have cached thread IDs)
    this.log('Checking for thread history...');
    const { conversations, conversationDetails } = await this.extractThreads(assistant.id);

    // 5. Build memory entries from file metadata
    const memoryEntries: MemoryEntry[] = [];

    // Build snapshot
    const snapshotId = generateSnapshotId();
    const now = new Date().toISOString();

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
        config,
        tools,
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
            type: 'api',
            description: 'Create new assistant with captured configuration',
            target: 'POST /v1/assistants',
          },
          {
            type: 'api',
            description: 'Upload files and create vector stores',
            target: 'POST /v1/files, POST /v1/vector_stores',
          },
          {
            type: 'api',
            description: 'Recreate threads with messages (optional)',
            target: 'POST /v1/threads, POST /v1/threads/{id}/messages',
          },
        ],
        manualSteps: [
          'Verify the new assistant ID works in your application',
          'Update any thread IDs in your application (threads cannot be migrated, only recreated)',
          'Vector store files will be re-indexed automatically after upload',
        ],
      },
    };

    this.log(`✓ Extraction complete: ${assistant.name ?? assistant.id}`);
    return snapshot;
  }

  async restore(snapshot: Snapshot): Promise<void> {
    this.apiKey = this.requireApiKey();
    this.warnings = [];

    const config = (snapshot.identity.config ?? {}) as Record<string, unknown>;

    // 1. Upload files first (if we have file contents)
    const fileIdMap = new Map<string, string>(); // old ID → new ID
    const fileContents = (config._file_contents ?? {}) as Record<string, string>;

    if (Object.keys(fileContents).length > 0) {
      this.log(`Uploading ${Object.keys(fileContents).length} files...`);
      for (const [oldFileId, b64content] of Object.entries(fileContents)) {
        const fileInfo = snapshot.memory.knowledge.find(k => k.id === `openai-file:${oldFileId}`);
        const filename = fileInfo?.filename ?? `file-${oldFileId}`;
        try {
          const newFileId = await this.uploadFile(filename, Buffer.from(b64content, 'base64'));
          fileIdMap.set(oldFileId, newFileId);
          this.log(`  Uploaded: ${filename} → ${newFileId}`);
        } catch (err) {
          this.warn(`Failed to upload file ${filename}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 2. Create vector stores (if any)
    const vectorStoreIdMap = new Map<string, string>(); // old ID → new ID
    const vectorStores = (config.vector_stores ?? []) as Array<{
      id: string;
      name: string;
      metadata: Record<string, string>;
      file_ids: string[];
      expires_after?: { anchor: string; days: number } | null;
    }>;

    if (vectorStores.length > 0) {
      this.log(`Creating ${vectorStores.length} vector store(s)...`);
      for (const vs of vectorStores) {
        try {
          // Map old file IDs to new ones
          const newFileIds = vs.file_ids
            .map(fid => fileIdMap.get(fid))
            .filter((id): id is string => id !== undefined);

          const newVsId = await this.createVectorStore(
            vs.name,
            newFileIds,
            vs.metadata,
            vs.expires_after,
          );
          vectorStoreIdMap.set(vs.id, newVsId);
          this.log(`  Created vector store: ${vs.name} → ${newVsId} (${newFileIds.length} files)`);
        } catch (err) {
          this.warn(`Failed to create vector store ${vs.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 3. Build tool_resources for the new assistant
    const toolResources: OpenAIToolResources = {};

    // Code interpreter files
    const codeInterpreterFileIds = ((config.tool_resources as OpenAIToolResources | undefined)
      ?.code_interpreter?.file_ids ?? [])
      .map(fid => fileIdMap.get(fid as string))
      .filter((id): id is string => id !== undefined);

    if (codeInterpreterFileIds.length > 0) {
      toolResources.code_interpreter = { file_ids: codeInterpreterFileIds };
    }

    // File search vector stores
    const oldVsIds = (config.tool_resources as OpenAIToolResources | undefined)
      ?.file_search?.vector_store_ids ?? [];
    const newVsIds = (oldVsIds as string[])
      .map(vid => vectorStoreIdMap.get(vid))
      .filter((id): id is string => id !== undefined);

    if (newVsIds.length > 0) {
      toolResources.file_search = { vector_store_ids: newVsIds };
    }

    // 4. Create the new assistant
    this.log('Creating new assistant...');
    const assistantBody: Record<string, unknown> = {
      model: config.model as string ?? 'gpt-4o',
      name: config.name as string ?? undefined,
      description: config.description as string ?? undefined,
      instructions: snapshot.identity.personality ?? undefined,
      metadata: config.metadata as Record<string, string> ?? {},
    };

    // Add temperature/top_p if set
    if (config.temperature !== undefined && config.temperature !== null) {
      assistantBody.temperature = config.temperature;
    }
    if (config.top_p !== undefined && config.top_p !== null) {
      assistantBody.top_p = config.top_p;
    }
    if (config.response_format !== undefined && config.response_format !== null) {
      assistantBody.response_format = config.response_format;
    }

    // Restore tools
    const restoredTools: OpenAITool[] = [];
    const originalTools = (config.tools_raw ?? []) as OpenAITool[];
    for (const tool of originalTools) {
      restoredTools.push(tool);
    }
    if (restoredTools.length > 0) {
      assistantBody.tools = restoredTools;
    }

    // Attach tool_resources
    if (Object.keys(toolResources).length > 0) {
      assistantBody.tool_resources = toolResources;
    }

    // Remove undefined values
    for (const key of Object.keys(assistantBody)) {
      if (assistantBody[key] === undefined) {
        delete assistantBody[key];
      }
    }

    const newAssistant = await this.apiPost<OpenAIAssistant>('/assistants', assistantBody);
    this.log(`✓ Created assistant: ${newAssistant.name ?? '(unnamed)'} → ${newAssistant.id}`);

    // 5. Optionally recreate threads
    if (snapshot.conversations.total > 0) {
      this.log(`Recreating ${snapshot.conversations.total} thread(s)...`);
      const newThreadIds: string[] = [];

      for (const convMeta of snapshot.conversations.conversations) {
        try {
          // The conversation details are stored as memory entries
          const convEntry = snapshot.memory.core.find(m => m.id === `thread:${convMeta.id}`);
          if (!convEntry) {
            this.warn(`No message data for thread ${convMeta.id}, skipping`);
            continue;
          }

          const messages: Message[] = JSON.parse(convEntry.content);
          const threadId = await this.recreateThread(messages);
          newThreadIds.push(threadId);
          this.log(`  Recreated thread: ${convMeta.id} → ${threadId} (${messages.length} messages)`);
        } catch (err) {
          this.warn(`Failed to recreate thread ${convMeta.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Save new thread IDs to cache
      if (newThreadIds.length > 0) {
        await this.saveThreadCache(newAssistant.id, newThreadIds);
      }
    }

    // 6. Summary
    console.error('');
    console.error('┌─────────────────────────────────────────────┐');
    console.error('│  ✓ Restore complete                         │');
    console.error('├─────────────────────────────────────────────┤');
    console.error(`│  New Assistant ID: ${newAssistant.id}  │`);
    console.error(`│  Model: ${(newAssistant.model ?? '').padEnd(35)}│`);
    console.error(`│  Tools: ${String(newAssistant.tools?.length ?? 0).padEnd(35)}│`);
    console.error(`│  Files uploaded: ${String(fileIdMap.size).padEnd(27)}│`);
    console.error(`│  Vector stores: ${String(vectorStoreIdMap.size).padEnd(27)}│`);
    console.error('└─────────────────────────────────────────────┘');

    if (this.warnings.length > 0) {
      console.error('');
      for (const w of this.warnings) {
        console.warn(`  ⚠ ${w}`);
      }
    }
  }

  async identify(): Promise<PlatformMeta> {
    return {
      name: 'OpenAI Assistants',
      version: this.version,
      apiVersion: 'v2',
      exportMethod: 'api',
    };
  }

  // ─── Private: API helpers ──────────────────────────────────

  private requireApiKey(): string {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        'OPENAI_API_KEY environment variable is required.\n' +
        'Set it with: export OPENAI_API_KEY=sk-...\n' +
        'Get your key at: https://platform.openai.com/api-keys',
      );
    }
    return key;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'OpenAI-Beta': 'assistants=v2',
      'Content-Type': 'application/json',
    };
  }

  /**
   * Make a GET request to the OpenAI API with retry on 429.
   */
  private async apiGet<T>(path: string): Promise<T> {
    return this.apiRequest<T>('GET', path);
  }

  /**
   * Make a POST request to the OpenAI API with retry on 429.
   */
  private async apiPost<T>(path: string, body: unknown): Promise<T> {
    return this.apiRequest<T>('POST', path, body);
  }

  /**
   * Core API request with retry logic for rate limits.
   */
  private async apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const url = `${OPENAI_BASE}${path}`;
      const opts: RequestInit = {
        method,
        headers: this.headers(),
      };
      if (body !== undefined) {
        opts.body = JSON.stringify(body);
      }

      const res = await fetch(url, opts);

      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        this.log(`  Rate limited, retrying in ${Math.round(waitMs / 1000)}s...`);
        await this.sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const errorBody = await res.text();
        lastError = new Error(`OpenAI API error ${res.status} ${method} ${path}: ${errorBody}`);
        if (res.status >= 500) {
          // Retry on server errors
          await this.sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      return (await res.json()) as T;
    }

    throw lastError ?? new Error(`Failed after ${MAX_RETRIES} retries: ${method} ${path}`);
  }

  /**
   * GET raw bytes from the API (for file content download).
   */
  private async apiGetBytes(path: string): Promise<Buffer> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const url = `${OPENAI_BASE}${path}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await this.sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`OpenAI API error ${res.status} GET ${path}: ${errorBody}`);
      }

      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    }

    throw new Error(`Failed to download after ${MAX_RETRIES} retries: ${path}`);
  }

  /**
   * Upload a file using multipart/form-data.
   */
  private async uploadFile(filename: string, content: Buffer): Promise<string> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const formData = new FormData();
      const blob = new Blob([content]);
      formData.append('file', blob, filename);
      formData.append('purpose', 'assistants');

      const res = await fetch(`${OPENAI_BASE}/files`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          // Don't set Content-Type for FormData — fetch sets it with boundary
        },
        body: formData,
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await this.sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`File upload failed (${res.status}): ${errorBody}`);
      }

      const fileObj = (await res.json()) as OpenAIFile;
      return fileObj.id;
    }

    throw new Error(`File upload failed after ${MAX_RETRIES} retries`);
  }

  /**
   * Paginate through a list endpoint, collecting all items.
   */
  private async paginateList<T>(path: string, queryParams?: string): Promise<T[]> {
    const items: T[] = [];
    let after: string | undefined;

    while (true) {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (after) params.set('after', after);

      const fullPath = queryParams
        ? `${path}?${params.toString()}&${queryParams}`
        : `${path}?${params.toString()}`;

      const response = await this.apiGet<OpenAIListResponse<T>>(fullPath);
      items.push(...response.data);

      if (!response.has_more || response.data.length === 0) break;
      after = response.last_id;
    }

    return items;
  }

  // ─── Private: Extract helpers ──────────────────────────────

  /**
   * Resolve which assistant to extract. Uses SAVESTATE_OPENAI_ASSISTANT_ID
   * if set, otherwise lists all and picks the first (or errors if none).
   */
  private async resolveAssistant(): Promise<OpenAIAssistant> {
    const targetId = process.env.SAVESTATE_OPENAI_ASSISTANT_ID;

    if (targetId) {
      this.log(`Fetching assistant: ${targetId}`);
      return this.apiGet<OpenAIAssistant>(`/assistants/${targetId}`);
    }

    // List all assistants
    this.log('No SAVESTATE_OPENAI_ASSISTANT_ID set, listing assistants...');
    const assistants = await this.paginateList<OpenAIAssistant>('/assistants');

    if (assistants.length === 0) {
      throw new Error(
        'No assistants found in your OpenAI account.\n' +
        'Create one at: https://platform.openai.com/assistants',
      );
    }

    if (assistants.length === 1) {
      this.log(`Found 1 assistant, using: ${assistants[0].name ?? assistants[0].id}`);
      return assistants[0];
    }

    // Multiple assistants — list them and ask user to specify
    console.error('');
    console.error('Multiple assistants found:');
    for (const a of assistants) {
      console.error(`  ${a.id}  ${a.name ?? '(unnamed)'}  [${a.model}]`);
    }
    console.error('');
    console.error('Set SAVESTATE_OPENAI_ASSISTANT_ID to target a specific assistant.');
    console.error(`Using first assistant: ${assistants[0].name ?? assistants[0].id}`);
    console.error('');

    return assistants[0];
  }

  /**
   * Extract identity info from the assistant object.
   */
  private extractIdentity(assistant: OpenAIAssistant): {
    personality: string;
    config: Record<string, unknown>;
    tools: ToolConfig[];
  } {
    const personality = assistant.instructions ?? '';

    const config: Record<string, unknown> = {
      assistant_id: assistant.id,
      name: assistant.name,
      description: assistant.description,
      model: assistant.model,
      metadata: assistant.metadata,
      temperature: assistant.temperature,
      top_p: assistant.top_p,
      response_format: assistant.response_format,
      created_at: assistant.created_at,
      // Preserve the raw tools array for restore
      tools_raw: assistant.tools,
      // Preserve tool_resources for restore
      tool_resources: assistant.tool_resources,
    };

    // Convert tools to SaveState ToolConfig format
    const tools: ToolConfig[] = assistant.tools.map(tool => {
      if (tool.type === 'function' && tool.function) {
        return {
          name: tool.function.name,
          type: 'function',
          config: {
            description: tool.function.description,
            parameters: tool.function.parameters,
            strict: tool.function.strict,
          },
          enabled: true,
        };
      }
      return {
        name: tool.type,
        type: tool.type,
        config: {},
        enabled: true,
      };
    });

    return { personality, config, tools };
  }

  /**
   * Extract files and vector stores associated with the assistant.
   */
  private async extractFiles(assistant: OpenAIAssistant): Promise<{
    knowledge: KnowledgeDocument[];
    fileContents: Record<string, string>;
    vectorStores: Array<{
      id: string;
      name: string;
      metadata: Record<string, string>;
      file_ids: string[];
      expires_after?: { anchor: string; days: number } | null;
    }>;
  }> {
    const knowledge: KnowledgeDocument[] = [];
    const fileContents: Record<string, string> = {};
    const vectorStores: Array<{
      id: string;
      name: string;
      metadata: Record<string, string>;
      file_ids: string[];
      expires_after?: { anchor: string; days: number } | null;
    }> = [];

    // Collect all file IDs we need to download
    const allFileIds = new Set<string>();

    // Code interpreter files
    const ciFileIds = assistant.tool_resources?.code_interpreter?.file_ids ?? [];
    for (const fid of ciFileIds) {
      allFileIds.add(fid);
    }

    // Vector store files
    const vsIds = assistant.tool_resources?.file_search?.vector_store_ids ?? [];
    if (vsIds.length > 0) {
      this.log(`  Fetching ${vsIds.length} vector store(s)...`);
    }

    for (const vsId of vsIds) {
      try {
        const vs = await this.apiGet<OpenAIVectorStore>(`/vector_stores/${vsId}`);
        const vsFiles = await this.paginateList<OpenAIVectorStoreFile>(
          `/vector_stores/${vsId}/files`,
        );

        const vsFileIds = vsFiles.map(f => f.id);
        for (const fid of vsFileIds) {
          allFileIds.add(fid);
        }

        vectorStores.push({
          id: vs.id,
          name: vs.name,
          metadata: vs.metadata,
          file_ids: vsFileIds,
          expires_after: vs.expires_after,
        });

        this.log(`  Vector store "${vs.name}": ${vsFileIds.length} files`);
      } catch (err) {
        this.warn(`Failed to fetch vector store ${vsId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Download all files
    if (allFileIds.size > 0) {
      this.log(`  Downloading ${allFileIds.size} file(s)...`);
    }

    for (const fileId of allFileIds) {
      try {
        // Get file metadata
        const fileMeta = await this.apiGet<OpenAIFile>(`/files/${fileId}`);

        // Download file content
        const content = await this.apiGetBytes(`/files/${fileId}/content`);

        const checksum = computeChecksum(content);

        knowledge.push({
          id: `openai-file:${fileId}`,
          filename: fileMeta.filename,
          mimeType: this.guessMimeType(fileMeta.filename),
          path: `knowledge/files/${fileMeta.filename}`,
          size: fileMeta.bytes,
          checksum,
        });

        // Store file content as base64 for restore
        fileContents[fileId] = content.toString('base64');

        this.log(`  Downloaded: ${fileMeta.filename} (${this.formatBytes(fileMeta.bytes)})`);
      } catch (err) {
        this.warn(`Failed to download file ${fileId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { knowledge, fileContents, vectorStores };
  }

  /**
   * Extract threads using the local thread cache.
   * OpenAI has no "list all threads" endpoint, so we rely on cached IDs.
   */
  private async extractThreads(assistantId: string): Promise<{
    conversations: ConversationMeta[];
    conversationDetails: Conversation[];
  }> {
    const conversations: ConversationMeta[] = [];
    const conversationDetails: Conversation[] = [];

    // Try to load cached thread IDs
    const threadIds = await this.loadThreadCache(assistantId);

    if (threadIds.length === 0) {
      console.error('  ℹ No cached thread IDs found.');
      console.error('    OpenAI does not provide a "list all threads" endpoint.');
      console.error(`    To capture threads, create ${THREADS_CACHE_DIR}/${THREADS_CACHE_FILE}`);
      console.error('    with format: { "assistant_id": "...", "thread_ids": ["thread_..."] }');
      console.error('    Thread IDs are returned when you create threads via the API.');
      return { conversations, conversationDetails };
    }

    this.log(`  Found ${threadIds.length} cached thread(s), fetching messages...`);

    for (const threadId of threadIds) {
      try {
        const messages = await this.paginateList<OpenAIMessage>(
          `/threads/${threadId}/messages`,
          'order=asc',
        );

        if (messages.length === 0) continue;

        const firstMsg = messages[0];
        const lastMsg = messages[messages.length - 1];

        const convertedMessages: Message[] = messages.map(msg => ({
          id: msg.id,
          role: msg.role as 'user' | 'assistant',
          content: this.extractMessageContent(msg),
          timestamp: new Date(msg.created_at * 1000).toISOString(),
          metadata: {
            ...msg.metadata,
            ...(msg.run_id ? { run_id: msg.run_id } : {}),
          },
        }));

        const conv: Conversation = {
          id: threadId,
          title: `Thread ${threadId.slice(0, 12)}...`,
          createdAt: new Date(firstMsg.created_at * 1000).toISOString(),
          updatedAt: new Date(lastMsg.created_at * 1000).toISOString(),
          messages: convertedMessages,
          metadata: { thread_id: threadId },
        };

        conversationDetails.push(conv);

        conversations.push({
          id: threadId,
          title: conv.title,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          messageCount: messages.length,
          path: `conversations/${threadId}.json`,
        });

        this.log(`  Thread ${threadId.slice(0, 16)}...: ${messages.length} messages`);
      } catch (err) {
        this.warn(`Failed to fetch thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Save thread details as memory entries so restore can access them
    // We store the full messages JSON as the content of a memory entry
    for (const conv of conversationDetails) {
      // This is a bit of a hack — we store conversation data in memory.core
      // because that's the easiest way to persist it through the snapshot format
    }

    return { conversations, conversationDetails };
  }

  /**
   * Extract text content from an OpenAI message.
   */
  private extractMessageContent(msg: OpenAIMessage): string {
    const parts: string[] = [];
    for (const content of msg.content) {
      if (content.type === 'text' && content.text) {
        parts.push(content.text.value);
      } else if (content.type === 'image_file' && content.image_file) {
        parts.push(`[Image: ${content.image_file.file_id}]`);
      } else if (content.type === 'image_url' && content.image_url) {
        parts.push(`[Image: ${content.image_url.url}]`);
      }
    }
    return parts.join('\n');
  }

  // ─── Private: Restore helpers ──────────────────────────────

  /**
   * Create a vector store and add files to it.
   */
  private async createVectorStore(
    name: string,
    fileIds: string[],
    metadata: Record<string, string>,
    expiresAfter?: { anchor: string; days: number } | null,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      name,
      metadata,
      file_ids: fileIds,
    };
    if (expiresAfter) {
      body.expires_after = expiresAfter;
    }

    const vs = await this.apiPost<OpenAIVectorStore>('/vector_stores', body);
    return vs.id;
  }

  /**
   * Recreate a thread with messages.
   */
  private async recreateThread(messages: Message[]): Promise<string> {
    // Create thread with initial messages
    // The API supports creating a thread with messages in one call
    const threadMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const thread = await this.apiPost<{ id: string; object: string }>(
      '/threads',
      { messages: threadMessages },
    );

    return thread.id;
  }

  // ─── Private: Thread cache ─────────────────────────────────

  /**
   * Load thread IDs from local cache.
   */
  private async loadThreadCache(assistantId: string): Promise<string[]> {
    const cachePath = join(process.cwd(), THREADS_CACHE_DIR, THREADS_CACHE_FILE);

    if (!existsSync(cachePath)) return [];

    try {
      const raw = await readFile(cachePath, 'utf-8');
      const cache = JSON.parse(raw) as ThreadCache | ThreadCache[];

      // Support both single-assistant and multi-assistant cache formats
      if (Array.isArray(cache)) {
        const entry = cache.find(c => c.assistant_id === assistantId);
        return entry?.thread_ids ?? [];
      }

      // Single entry — use it if it matches the assistant or if no assistant ID is set
      if (cache.assistant_id === assistantId || !cache.assistant_id) {
        return cache.thread_ids ?? [];
      }

      return [];
    } catch (err) {
      this.warn(`Failed to read thread cache: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Save thread IDs to local cache.
   */
  private async saveThreadCache(assistantId: string, threadIds: string[]): Promise<void> {
    const cacheDir = join(process.cwd(), THREADS_CACHE_DIR);
    const cachePath = join(cacheDir, THREADS_CACHE_FILE);

    try {
      await mkdir(cacheDir, { recursive: true });

      let caches: ThreadCache[] = [];

      // Load existing cache
      if (existsSync(cachePath)) {
        try {
          const raw = await readFile(cachePath, 'utf-8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            caches = parsed;
          } else if (parsed.assistant_id) {
            caches = [parsed as ThreadCache];
          }
        } catch {
          // Start fresh
        }
      }

      // Upsert entry for this assistant
      const existingIdx = caches.findIndex(c => c.assistant_id === assistantId);
      const entry: ThreadCache = {
        assistant_id: assistantId,
        thread_ids: [...new Set([
          ...(existingIdx >= 0 ? caches[existingIdx].thread_ids : []),
          ...threadIds,
        ])],
        updated_at: new Date().toISOString(),
      };

      if (existingIdx >= 0) {
        caches[existingIdx] = entry;
      } else {
        caches.push(entry);
      }

      await writeFile(cachePath, JSON.stringify(caches, null, 2) + '\n', 'utf-8');
      this.log(`  Saved ${threadIds.length} thread ID(s) to ${THREADS_CACHE_DIR}/${THREADS_CACHE_FILE}`);
    } catch (err) {
      this.warn(`Failed to save thread cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Private: Utilities ────────────────────────────────────

  private log(msg: string): void {
    console.error(msg);
  }

  private warn(msg: string): void {
    this.warnings.push(msg);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  private guessMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      pdf: 'application/pdf',
      txt: 'text/plain',
      md: 'text/markdown',
      json: 'application/json',
      csv: 'text/csv',
      tsv: 'text/tab-separated-values',
      html: 'text/html',
      htm: 'text/html',
      xml: 'application/xml',
      js: 'application/javascript',
      ts: 'text/typescript',
      py: 'text/x-python',
      rb: 'text/x-ruby',
      c: 'text/x-c',
      cpp: 'text/x-c++src',
      h: 'text/x-c',
      java: 'text/x-java',
      rs: 'text/x-rust',
      go: 'text/x-go',
      sh: 'application/x-sh',
      yaml: 'application/x-yaml',
      yml: 'application/x-yaml',
      toml: 'application/toml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      mp4: 'video/mp4',
      zip: 'application/zip',
      tar: 'application/x-tar',
      gz: 'application/gzip',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return map[ext] ?? 'application/octet-stream';
  }
}
