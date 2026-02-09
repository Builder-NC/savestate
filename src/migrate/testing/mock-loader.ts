/**
 * Mock Loader for Testing
 *
 * Simulates loading data to a platform for testing the orchestrator.
 */

import type {
  Platform,
  Loader,
  LoadOptions,
  LoadResult,
  MigrationBundle,
} from '../types.js';
import { randomBytes } from 'node:crypto';

export interface MockLoaderOptions {
  /** Simulate failure */
  shouldFail?: boolean;
  /** Failure message */
  failureMessage?: string;
  /** Delay loading by N ms */
  delayMs?: number;
  /** Custom load result */
  customResult?: LoadResult;
  /** Whether canLoad returns true */
  canLoadResult?: boolean;
  /** Simulate partial failure */
  partialFailure?: {
    memories?: boolean;
    files?: boolean;
  };
}

export class MockLoader implements Loader {
  readonly platform: Platform;
  readonly version = '1.0.0-mock';

  private options: MockLoaderOptions;
  private progress = 0;

  /** Track what was loaded for testing assertions */
  public loadedBundles: MigrationBundle[] = [];

  constructor(platform: Platform, options: MockLoaderOptions = {}) {
    this.platform = platform;
    this.options = options;
  }

  async canLoad(): Promise<boolean> {
    return this.options.canLoadResult ?? true;
  }

  async load(bundle: MigrationBundle, options: LoadOptions): Promise<LoadResult> {
    this.progress = 0;

    // Simulate delay
    if (this.options.delayMs) {
      const steps = 10;
      const stepDelay = this.options.delayMs / steps;
      for (let i = 0; i < steps; i++) {
        await new Promise((r) => setTimeout(r, stepDelay));
        this.progress = ((i + 1) / steps) * 100;
        options.onProgress?.(this.progress / 100, `Loading step ${i + 1}/${steps}`);
      }
    }

    // Simulate failure
    if (this.options.shouldFail) {
      throw new Error(this.options.failureMessage ?? 'Mock load failed');
    }

    // Return custom result if provided
    if (this.options.customResult) {
      return this.options.customResult;
    }

    // Track loaded bundle for testing
    this.loadedBundles.push(bundle);

    const warnings: string[] = [];
    const errors: string[] = [];

    // Calculate what was loaded
    let memoriesLoaded = bundle.contents.memories?.count ?? 0;
    let filesLoaded = bundle.contents.files?.count ?? 0;

    // Simulate partial failure
    if (this.options.partialFailure?.memories) {
      memoriesLoaded = Math.floor(memoriesLoaded / 2);
      warnings.push('Some memories failed to load');
    }
    if (this.options.partialFailure?.files) {
      filesLoaded = 0;
      errors.push('File upload failed');
    }

    const projectId = `proj_${randomBytes(6).toString('hex')}`;

    return {
      success: true,
      loaded: {
        instructions: !!bundle.contents.instructions,
        memories: memoriesLoaded,
        files: filesLoaded,
        customBots: bundle.contents.customBots?.count ?? 0,
      },
      created: {
        projectId,
        projectUrl: `https://mock.${this.platform}.com/projects/${projectId}`,
      },
      warnings,
      errors,
      manualSteps: bundle.contents.customBots
        ? ['Custom bots may require manual configuration']
        : undefined,
    };
  }

  getProgress(): number {
    return this.progress;
  }
}
