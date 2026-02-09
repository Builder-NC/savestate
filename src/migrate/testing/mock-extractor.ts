/**
 * Mock Extractor for Testing
 *
 * Simulates extracting data from a platform for testing the orchestrator.
 */

import type {
  Platform,
  Extractor,
  ExtractOptions,
  MigrationBundle,
} from '../types.js';
import { randomBytes } from 'node:crypto';

export interface MockExtractorOptions {
  /** Simulate failure */
  shouldFail?: boolean;
  /** Failure message */
  failureMessage?: string;
  /** Delay extraction by N ms */
  delayMs?: number;
  /** Custom bundle to return */
  customBundle?: MigrationBundle;
  /** Whether canExtract returns true */
  canExtractResult?: boolean;
}

export class MockExtractor implements Extractor {
  readonly platform: Platform;
  readonly version = '1.0.0-mock';

  private options: MockExtractorOptions;
  private progress = 0;

  constructor(platform: Platform, options: MockExtractorOptions = {}) {
    this.platform = platform;
    this.options = options;
  }

  async canExtract(): Promise<boolean> {
    return this.options.canExtractResult ?? true;
  }

  async extract(options: ExtractOptions): Promise<MigrationBundle> {
    this.progress = 0;

    // Simulate delay
    if (this.options.delayMs) {
      const steps = 10;
      const stepDelay = this.options.delayMs / steps;
      for (let i = 0; i < steps; i++) {
        await new Promise((r) => setTimeout(r, stepDelay));
        this.progress = ((i + 1) / steps) * 100;
        options.onProgress?.(this.progress / 100, `Extracting step ${i + 1}/${steps}`);
      }
    }

    // Simulate failure
    if (this.options.shouldFail) {
      throw new Error(this.options.failureMessage ?? 'Mock extraction failed');
    }

    // Return custom bundle or generate a mock one
    if (this.options.customBundle) {
      return this.options.customBundle;
    }

    return this.generateMockBundle();
  }

  getProgress(): number {
    return this.progress;
  }

  private generateMockBundle(): MigrationBundle {
    const bundleId = `bundle_${randomBytes(8).toString('hex')}`;

    return {
      version: '1.0',
      id: bundleId,
      source: {
        platform: this.platform,
        extractedAt: new Date().toISOString(),
        accountId: 'mock-account-123',
        extractorVersion: this.version,
      },
      contents: {
        instructions: {
          content: `Mock instructions from ${this.platform}.\n\nThis is a test instruction set with multiple paragraphs.\n\nIt includes guidance on how the AI should behave.`,
          length: 150,
          sections: [
            { title: 'Identity', content: 'I am a helpful assistant', priority: 'high' },
            { title: 'Guidelines', content: 'Be helpful, accurate, and safe', priority: 'medium' },
          ],
        },
        memories: {
          entries: [
            {
              id: 'mem_1',
              content: 'User prefers concise responses',
              createdAt: new Date().toISOString(),
              category: 'preferences',
            },
            {
              id: 'mem_2',
              content: 'User is a software developer',
              createdAt: new Date().toISOString(),
              category: 'context',
            },
            {
              id: 'mem_3',
              content: 'User lives in New York',
              createdAt: new Date().toISOString(),
              category: 'context',
            },
          ],
          count: 3,
        },
        conversations: {
          path: 'conversations/',
          count: 5,
          messageCount: 42,
          summaries: [
            {
              id: 'conv_1',
              title: 'Project Discussion',
              messageCount: 12,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: 'conv_2',
              title: 'Code Review',
              messageCount: 30,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        files: {
          files: [
            {
              id: 'file_1',
              filename: 'project-notes.md',
              mimeType: 'text/markdown',
              size: 2048,
              path: 'files/project-notes.md',
            },
          ],
          count: 1,
          totalSize: 2048,
        },
      },
      metadata: {
        totalItems: 10,
        itemCounts: {
          instructions: 1,
          memories: 3,
          conversations: 5,
          files: 1,
          customBots: 0,
        },
        warnings: [],
        errors: [],
      },
    };
  }
}
