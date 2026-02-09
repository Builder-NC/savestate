/**
 * Claude Loader Tests
 *
 * Tests for the Claude Projects loader implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeLoader, type ClaudeLoaderConfig } from '../loaders/claude.js';
import type { MigrationBundle, MemoryEntry, FileEntry, ConversationSummary } from '../types.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('ClaudeLoader', () => {
  let testWorkDir: string;
  let loader: ClaudeLoader;

  // Helper to create a test bundle
  function createTestBundle(overrides: Partial<MigrationBundle> = {}): MigrationBundle {
    return {
      version: '1.0',
      id: 'test-bundle-123',
      source: {
        platform: 'chatgpt',
        extractedAt: '2026-02-07T10:00:00Z',
        extractorVersion: '1.0.0',
      },
      target: {
        platform: 'claude',
        transformedAt: '2026-02-07T11:00:00Z',
        transformerVersion: '1.0.0',
      },
      contents: {
        instructions: {
          content: 'You are a helpful assistant. Be concise and accurate.',
          length: 49,
        },
        memories: {
          entries: [
            { id: 'm1', content: 'User prefers dark mode', createdAt: '2026-01-01T00:00:00Z', category: 'Preferences' },
            { id: 'm2', content: 'User works in tech industry', createdAt: '2026-01-02T00:00:00Z', category: 'Work' },
            { id: 'm3', content: 'User likes TypeScript', createdAt: '2026-01-03T00:00:00Z', category: 'Preferences' },
          ],
          count: 3,
        },
        ...overrides.contents,
      },
      metadata: {
        totalItems: 4,
        itemCounts: {
          instructions: 1,
          memories: 3,
          conversations: 0,
          files: 0,
          customBots: 0,
        },
        warnings: [],
        errors: [],
        ...overrides.metadata,
      },
      ...overrides,
    };
  }

  // Helper to mock successful API responses
  function mockApiSuccess() {
    mockFetch.mockImplementation(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options.method || 'GET';

      // Create project
      if (method === 'POST' && path === '/v1/projects') {
        return new Response(
          JSON.stringify({
            id: 'proj_test123',
            name: 'Test Project',
            created_at: '2026-02-07T12:00:00Z',
            updated_at: '2026-02-07T12:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Update project prompt
      if (method === 'PUT' && path.match(/\/v1\/projects\/[^/]+$/)) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Create document
      if (method === 'POST' && path.match(/\/v1\/projects\/[^/]+\/docs$/)) {
        return new Response(
          JSON.stringify({
            id: `doc_${Date.now()}`,
            name: 'test.md',
            content: 'test',
            created_at: '2026-02-07T12:00:00Z',
            updated_at: '2026-02-07T12:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Upload file
      if (method === 'POST' && path.match(/\/v1\/projects\/[^/]+\/files$/)) {
        return new Response(
          JSON.stringify({
            id: `file_${Date.now()}`,
            name: 'test.txt',
            content_type: 'text/plain',
            size: 100,
            created_at: '2026-02-07T12:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Delete project
      if (method === 'DELETE' && path.match(/\/v1\/projects\/[^/]+$/)) {
        return new Response(null, { status: 204 });
      }

      return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
    });
  }

  beforeEach(async () => {
    testWorkDir = join(tmpdir(), `claude-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testWorkDir, { recursive: true });

    mockFetch.mockReset();

    loader = new ClaudeLoader({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.anthropic.com',
    });
  });

  afterEach(async () => {
    if (existsSync(testWorkDir)) {
      await rm(testWorkDir, { recursive: true, force: true });
    }
  });

  describe('canLoad', () => {
    it('should return true when API key is set', async () => {
      const result = await loader.canLoad();
      expect(result).toBe(true);
    });

    it('should return false when API key is missing', async () => {
      const loaderNoKey = new ClaudeLoader({ apiKey: '' });
      const result = await loaderNoKey.canLoad();
      expect(result).toBe(false);
    });
  });

  describe('load - success cases', () => {
    it('should create a Claude project with all components', async () => {
      mockApiSuccess();
      const bundle = createTestBundle();

      const result = await loader.load(bundle, {
        projectName: 'Test Migration',
      });

      expect(result.success).toBe(true);
      expect(result.loaded.instructions).toBe(true);
      expect(result.loaded.memories).toBe(3);
      expect(result.created?.projectId).toBe('proj_test123');
      expect(result.created?.projectUrl).toContain('proj_test123');
      expect(result.errors).toHaveLength(0);
    });

    it('should set system prompt from instructions', async () => {
      mockApiSuccess();
      const bundle = createTestBundle();

      await loader.load(bundle, {});

      // Verify PUT request was made to update project prompt
      const putCalls = mockFetch.mock.calls.filter(
        (call) => {
          const [url, opts] = call as [string, RequestInit];
          return opts.method === 'PUT' && url.includes('/v1/projects/');
        },
      );
      expect(putCalls.length).toBe(1);

      const [, opts] = putCalls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.prompt_template).toBe(bundle.contents.instructions?.content);
    });

    it('should create memories document with formatted content', async () => {
      mockApiSuccess();
      const bundle = createTestBundle();

      await loader.load(bundle, {});

      // Verify POST request was made to create document
      const docCalls = mockFetch.mock.calls.filter(
        (call) => {
          const [url, opts] = call as [string, RequestInit];
          return opts.method === 'POST' && url.includes('/docs');
        },
      );
      expect(docCalls.length).toBeGreaterThanOrEqual(1);

      const [, opts] = docCalls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.name).toBe('memories.md');
      expect(body.content).toContain('Migrated Memories');
      expect(body.content).toContain('User prefers dark mode');
    });

    it('should handle bundle without instructions', async () => {
      mockApiSuccess();
      const bundle = createTestBundle({
        contents: {
          memories: {
            entries: [{ id: 'm1', content: 'Test memory', createdAt: '2026-01-01T00:00:00Z' }],
            count: 1,
          },
        },
      });

      const result = await loader.load(bundle, {});

      expect(result.success).toBe(true);
      expect(result.loaded.instructions).toBe(false);
      expect(result.loaded.memories).toBe(1);
    });

    it('should handle bundle without memories', async () => {
      mockApiSuccess();
      const bundle = createTestBundle({
        contents: {
          instructions: { content: 'Test instructions', length: 17 },
        },
      });

      const result = await loader.load(bundle, {});

      expect(result.success).toBe(true);
      expect(result.loaded.instructions).toBe(true);
      expect(result.loaded.memories).toBe(0);
    });

    it('should track progress during load', async () => {
      mockApiSuccess();
      const bundle = createTestBundle();
      const progressUpdates: Array<{ progress: number; message: string }> = [];

      await loader.load(bundle, {
        onProgress: (progress, message) => {
          progressUpdates.push({ progress, message });
        },
      });

      expect(progressUpdates.length).toBeGreaterThan(0);

      // Progress should increase monotonically
      let lastProgress = 0;
      for (const update of progressUpdates) {
        expect(update.progress).toBeGreaterThanOrEqual(lastProgress);
        lastProgress = update.progress;
      }

      // Should reach 100%
      expect(progressUpdates[progressUpdates.length - 1].progress).toBe(1.0);
    });
  });

  describe('load - file uploads', () => {
    it('should upload files to project', async () => {
      mockApiSuccess();

      // Create a test file
      const testFilePath = join(testWorkDir, 'test-document.txt');
      await writeFile(testFilePath, 'Hello, this is test content');

      const bundle = createTestBundle({
        contents: {
          instructions: { content: 'Test', length: 4 },
          files: {
            files: [
              {
                id: 'f1',
                filename: 'test-document.txt',
                mimeType: 'text/plain',
                size: 27,
                path: testFilePath,
              },
            ],
            count: 1,
            totalSize: 27,
          },
        },
      });

      const result = await loader.load(bundle, {});

      expect(result.success).toBe(true);
      expect(result.loaded.files).toBe(1);

      // Verify file upload was called
      const fileCalls = mockFetch.mock.calls.filter(
        (call) => {
          const [url] = call as [string, RequestInit];
          return url.includes('/files');
        },
      );
      expect(fileCalls.length).toBe(1);
    });

    it('should skip files exceeding size limit', async () => {
      mockApiSuccess();

      const testFilePath = join(testWorkDir, 'large-file.txt');
      await writeFile(testFilePath, 'x'.repeat(100));

      const bundle = createTestBundle({
        contents: {
          instructions: { content: 'Test', length: 4 },
          files: {
            files: [
              {
                id: 'f1',
                filename: 'large-file.txt',
                mimeType: 'text/plain',
                size: 50 * 1024 * 1024, // 50MB (exceeds 32MB limit)
                path: testFilePath,
              },
            ],
            count: 1,
            totalSize: 50 * 1024 * 1024,
          },
        },
      });

      const result = await loader.load(bundle, {});

      expect(result.success).toBe(true);
      expect(result.loaded.files).toBe(0);
      expect(result.warnings).toContainEqual(expect.stringContaining('exceeds size limit'));
    });

    it('should warn about missing files', async () => {
      mockApiSuccess();

      const bundle = createTestBundle({
        contents: {
          instructions: { content: 'Test', length: 4 },
          files: {
            files: [
              {
                id: 'f1',
                filename: 'missing-file.txt',
                mimeType: 'text/plain',
                size: 100,
                path: '/nonexistent/missing-file.txt',
              },
            ],
            count: 1,
            totalSize: 100,
          },
        },
      });

      const result = await loader.load(bundle, {});

      expect(result.success).toBe(true);
      expect(result.loaded.files).toBe(0);
      expect(result.warnings).toContainEqual(expect.stringContaining('not found'));
    });
  });

  describe('load - context summary', () => {
    it('should create context summary from conversation summaries', async () => {
      mockApiSuccess();

      const bundle = createTestBundle({
        contents: {
          instructions: { content: 'Test', length: 4 },
          conversations: {
            path: '/conversations',
            count: 2,
            messageCount: 100,
            summaries: [
              {
                id: 'c1',
                title: 'Project Discussion',
                messageCount: 50,
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-02T00:00:00Z',
                keyPoints: ['Decided to use TypeScript', 'Agreed on weekly meetings'],
              },
              {
                id: 'c2',
                title: 'Code Review',
                messageCount: 50,
                createdAt: '2026-01-03T00:00:00Z',
                updatedAt: '2026-01-04T00:00:00Z',
                keyPoints: ['Need more tests', 'Consider refactoring auth module'],
              },
            ],
          },
        },
      });

      await loader.load(bundle, {});

      // Verify context summary document was created
      const docCalls = mockFetch.mock.calls.filter(
        (call) => {
          const [url, opts] = call as [string, RequestInit];
          return opts.method === 'POST' && url.includes('/docs');
        },
      );

      const contextDocCall = docCalls.find((call) => {
        const [, opts] = call as [string, RequestInit];
        const body = JSON.parse(opts.body as string);
        return body.name === 'context-summary.md';
      });

      expect(contextDocCall).toBeDefined();
      const [, contextOpts] = contextDocCall as [string, RequestInit];
      const body = JSON.parse(contextOpts.body as string);
      expect(body.content).toContain('Conversation Context Summary');
      expect(body.content).toContain('Decided to use TypeScript');
    });
  });

  describe('load - dry run', () => {
    it('should not make API calls in dry run mode', async () => {
      const bundle = createTestBundle();

      const result = await loader.load(bundle, { dryRun: true });

      expect(result.success).toBe(true);
      expect(result.warnings).toContain('Dry run - no changes made');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should report potential issues in dry run', async () => {
      const bundle = createTestBundle({
        contents: {
          instructions: { content: 'x'.repeat(10000), length: 10000 }, // Exceeds 8000 char limit
        },
      });

      const result = await loader.load(bundle, { dryRun: true });

      expect(result.warnings).toContainEqual(expect.stringContaining('would be truncated'));
    });
  });

  describe('load - error handling', () => {
    it('should handle API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
        }),
      );

      const bundle = createTestBundle();

      const result = await loader.load(bundle, {});

      expect(result.success).toBe(false);
      expect(result.errors).toContainEqual(expect.stringContaining('Invalid API key'));
    });

    it('should return partial results on mid-load failure', async () => {
      // First call succeeds (create project)
      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'proj_partial',
              name: 'Partial Project',
              created_at: '2026-02-07T12:00:00Z',
              updated_at: '2026-02-07T12:00:00Z',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
        // Second call fails (set prompt)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: 'Server error' } }), {
            status: 500,
          }),
        );

      const bundle = createTestBundle();

      const result = await loader.load(bundle, {});

      expect(result.success).toBe(false);
      expect(result.created?.projectId).toBe('proj_partial');
      expect(result.loaded.instructions).toBe(false);
    });

    it('should retry on rate limit errors', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
            status: 429,
            headers: { 'retry-after': '0' }, // Immediate retry for test
          });
        }
        return new Response(
          JSON.stringify({
            id: 'proj_retry',
            name: 'Retry Project',
            created_at: '2026-02-07T12:00:00Z',
            updated_at: '2026-02-07T12:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const bundle = createTestBundle({
        contents: {
          instructions: { content: 'Test', length: 4 },
        },
      });

      // Use minimal bundle to reduce API calls
      bundle.contents.memories = undefined;

      const loaderWithRetry = new ClaudeLoader({
        apiKey: 'test-key',
        retryDelayMs: 10, // Fast retries for test
      });

      const result = await loaderWithRetry.load(bundle, {});

      expect(result.success).toBe(true);
      expect(callCount).toBeGreaterThan(1);
    });
  });

  describe('load - bundle validation', () => {
    it('should reject bundles not transformed for Claude', async () => {
      const bundle = createTestBundle({
        target: {
          platform: 'chatgpt',
          transformedAt: '2026-02-07T11:00:00Z',
          transformerVersion: '1.0.0',
        },
      });

      await expect(loader.load(bundle, {})).rejects.toThrow('not transformed for Claude');
    });
  });

  describe('load - custom bots handling', () => {
    it('should add manual steps when custom bots are present', async () => {
      mockApiSuccess();

      const bundle = createTestBundle({
        contents: {
          instructions: { content: 'Test', length: 4 },
          customBots: {
            bots: [
              {
                id: 'gpt1',
                name: 'My Custom GPT',
                instructions: 'Be helpful',
                createdAt: '2026-01-01T00:00:00Z',
              },
            ],
            count: 1,
          },
        },
      });

      const result = await loader.load(bundle, {});

      expect(result.success).toBe(true);
      expect(result.loaded.customBots).toBe(0);
      expect(result.manualSteps).toBeDefined();
      expect(result.manualSteps).toContainEqual(expect.stringContaining('custom bots'));
    });
  });

  describe('load state management', () => {
    it('should track and expose load state for checkpointing', async () => {
      mockApiSuccess();
      const bundle = createTestBundle();

      await loader.load(bundle, {});

      const state = loader.getLoadState();

      expect(state.projectId).toBe('proj_test123');
      expect(state.instructionsLoaded).toBe(true);
      expect(state.memoriesDocId).toBeDefined();
    });

    it('should allow setting load state for resume', async () => {
      const previousState = {
        projectId: 'proj_resume',
        instructionsLoaded: true,
        memoriesDocId: 'doc_123',
        contextDocId: undefined,
        uploadedFileIds: ['file_1', 'file_2'],
        uploadedFilenames: ['a.txt', 'b.txt'],
        lastFileIndex: 1,
      };

      loader.setLoadState(previousState);
      const state = loader.getLoadState();

      expect(state.projectId).toBe('proj_resume');
      expect(state.uploadedFileIds).toEqual(['file_1', 'file_2']);
      expect(state.lastFileIndex).toBe(1);
    });
  });

  describe('getProgress', () => {
    it('should return current progress', async () => {
      mockApiSuccess();
      const bundle = createTestBundle();

      // Before load
      expect(loader.getProgress()).toBe(0);

      await loader.load(bundle, {});

      // After load
      expect(loader.getProgress()).toBe(100);
    });
  });

  describe('instructions truncation', () => {
    it('should truncate instructions exceeding limit and warn', async () => {
      mockApiSuccess();

      const longInstructions = 'x'.repeat(10000); // Exceeds 8000 char limit
      const bundle = createTestBundle({
        contents: {
          instructions: { content: longInstructions, length: 10000 },
        },
      });

      const result = await loader.load(bundle, {});

      expect(result.success).toBe(true);
      expect(result.warnings).toContainEqual(expect.stringContaining('truncated'));

      // Verify truncated content was sent
      const putCalls = mockFetch.mock.calls.filter(
        (call) => {
          const [url, opts] = call as [string, RequestInit];
          return opts.method === 'PUT' && url.includes('/v1/projects/');
        },
      );
      expect(putCalls.length).toBe(1);

      const [, opts] = putCalls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.prompt_template.length).toBe(8000);
    });
  });
});
