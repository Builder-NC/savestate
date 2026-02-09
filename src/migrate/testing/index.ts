/**
 * Migration Testing Utilities
 *
 * Mock implementations for testing the migration orchestrator.
 */

export { MockExtractor, type MockExtractorOptions } from './mock-extractor.js';
export { MockTransformer, type MockTransformerOptions } from './mock-transformer.js';
export { MockLoader, type MockLoaderOptions } from './mock-loader.js';

import type { Platform } from '../types.js';
import { registerExtractor } from '../extractors/registry.js';
import { registerTransformer } from '../transformers/registry.js';
import { registerLoader } from '../loaders/registry.js';
import { MockExtractor, type MockExtractorOptions } from './mock-extractor.js';
import { MockTransformer, type MockTransformerOptions } from './mock-transformer.js';
import { MockLoader, type MockLoaderOptions } from './mock-loader.js';

/**
 * Register all mock plugins for testing.
 *
 * This sets up extractors, transformers, and loaders for all platforms
 * using mock implementations.
 */
export function registerMockPlugins(options?: {
  extractors?: Partial<Record<Platform, MockExtractorOptions>>;
  transformers?: Partial<Record<`${Platform}->${Platform}`, MockTransformerOptions>>;
  loaders?: Partial<Record<Platform, MockLoaderOptions>>;
}): {
  extractors: Map<Platform, MockExtractor>;
  transformers: Map<string, MockTransformer>;
  loaders: Map<Platform, MockLoader>;
} {
  const platforms: Platform[] = ['chatgpt', 'claude', 'gemini', 'copilot'];
  const extractors = new Map<Platform, MockExtractor>();
  const transformers = new Map<string, MockTransformer>();
  const loaders = new Map<Platform, MockLoader>();

  // Register extractors for all platforms
  for (const platform of platforms) {
    const extractor = new MockExtractor(
      platform,
      options?.extractors?.[platform] ?? {},
    );
    extractors.set(platform, extractor);
    registerExtractor(platform, () => extractor);
  }

  // Register transformers for common paths
  const transformerPaths: [Platform, Platform][] = [
    ['chatgpt', 'claude'],
    ['claude', 'chatgpt'],
    ['chatgpt', 'gemini'],
    ['gemini', 'chatgpt'],
    ['claude', 'gemini'],
    ['gemini', 'claude'],
  ];

  for (const [source, target] of transformerPaths) {
    const key = `${source}->${target}` as `${Platform}->${Platform}`;
    const transformer = new MockTransformer(
      source,
      target,
      options?.transformers?.[key] ?? {},
    );
    transformers.set(key, transformer);
    registerTransformer(source, target, () => transformer);
  }

  // Register loaders for all platforms
  for (const platform of platforms) {
    const loader = new MockLoader(
      platform,
      options?.loaders?.[platform] ?? {},
    );
    loaders.set(platform, loader);
    registerLoader(platform, () => loader);
  }

  return { extractors, transformers, loaders };
}
