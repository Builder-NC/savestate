/**
 * Mock Transformer for Testing
 *
 * Simulates transforming data between platforms for testing the orchestrator.
 */

import type {
  Platform,
  Transformer,
  TransformOptions,
  MigrationBundle,
  CompatibilityReport,
  CompatibilityItem,
} from '../types.js';
import { getPlatformCapabilities } from '../capabilities.js';

export interface MockTransformerOptions {
  /** Simulate failure */
  shouldFail?: boolean;
  /** Failure message */
  failureMessage?: string;
  /** Delay transformation by N ms */
  delayMs?: number;
  /** Custom compatibility report */
  customReport?: CompatibilityReport;
}

export class MockTransformer implements Transformer {
  readonly source: Platform;
  readonly target: Platform;
  readonly version = '1.0.0-mock';

  private options: MockTransformerOptions;

  constructor(source: Platform, target: Platform, options: MockTransformerOptions = {}) {
    this.source = source;
    this.target = target;
    this.options = options;
  }

  async analyze(bundle: MigrationBundle): Promise<CompatibilityReport> {
    if (this.options.customReport) {
      return this.options.customReport;
    }

    const sourceCaps = getPlatformCapabilities(this.source);
    const targetCaps = getPlatformCapabilities(this.target);

    const items: CompatibilityItem[] = [];
    let perfect = 0;
    let adapted = 0;
    let incompatible = 0;

    // Analyze instructions
    if (bundle.contents.instructions) {
      const length = bundle.contents.instructions.length;
      if (length <= targetCaps.instructionLimit) {
        items.push({
          type: 'instructions',
          name: 'System Instructions',
          status: 'perfect',
          reason: `Within ${targetCaps.name}'s limit of ${targetCaps.instructionLimit} characters`,
        });
        perfect++;
      } else {
        items.push({
          type: 'instructions',
          name: 'System Instructions',
          status: 'adapted',
          reason: `Exceeds ${targetCaps.name}'s limit (${length} > ${targetCaps.instructionLimit})`,
          action: 'Will be summarized or truncated',
        });
        adapted++;
      }
    }

    // Analyze memories
    if (bundle.contents.memories && bundle.contents.memories.count > 0) {
      if (targetCaps.hasMemory) {
        const limit = targetCaps.memoryLimit ?? Infinity;
        if (bundle.contents.memories.count <= limit) {
          items.push({
            type: 'memory',
            name: 'Memory Entries',
            status: 'perfect',
            reason: `All ${bundle.contents.memories.count} memories can be migrated`,
          });
          perfect++;
        } else {
          items.push({
            type: 'memory',
            name: 'Memory Entries',
            status: 'adapted',
            reason: `${bundle.contents.memories.count} memories exceeds limit of ${limit}`,
            action: 'Most important memories will be selected',
          });
          adapted++;
        }
      } else {
        items.push({
          type: 'memory',
          name: 'Memory Entries',
          status: 'adapted',
          reason: `${targetCaps.name} doesn't support explicit memories`,
          action: 'Will be converted to knowledge documents',
        });
        adapted++;
      }
    }

    // Analyze files
    if (bundle.contents.files && bundle.contents.files.count > 0) {
      if (targetCaps.hasFiles) {
        items.push({
          type: 'file',
          name: 'Uploaded Files',
          status: 'perfect',
          reason: `All ${bundle.contents.files.count} files can be migrated`,
        });
        perfect++;
      } else {
        items.push({
          type: 'file',
          name: 'Uploaded Files',
          status: 'incompatible',
          reason: `${targetCaps.name} doesn't support file uploads`,
        });
        incompatible++;
      }
    }

    const total = perfect + adapted + incompatible;
    let feasibility: 'easy' | 'moderate' | 'complex' | 'partial';
    if (incompatible === 0 && adapted === 0) {
      feasibility = 'easy';
    } else if (incompatible === 0) {
      feasibility = 'moderate';
    } else if (incompatible < total / 2) {
      feasibility = 'complex';
    } else {
      feasibility = 'partial';
    }

    return {
      source: this.source,
      target: this.target,
      generatedAt: new Date().toISOString(),
      summary: { perfect, adapted, incompatible, total },
      items,
      recommendations:
        adapted > 0 ? ['Review adapted items before migration'] : [],
      feasibility,
    };
  }

  async transform(
    bundle: MigrationBundle,
    options: TransformOptions,
  ): Promise<MigrationBundle> {
    // Simulate delay
    if (this.options.delayMs) {
      const steps = 10;
      const stepDelay = this.options.delayMs / steps;
      for (let i = 0; i < steps; i++) {
        await new Promise((r) => setTimeout(r, stepDelay));
        options.onProgress?.(((i + 1) / steps) * 100, `Transforming step ${i + 1}/${steps}`);
      }
    }

    // Simulate failure
    if (this.options.shouldFail) {
      throw new Error(this.options.failureMessage ?? 'Mock transformation failed');
    }

    const targetCaps = getPlatformCapabilities(this.target);

    // Create transformed bundle
    const transformed: MigrationBundle = {
      ...bundle,
      target: {
        platform: this.target,
        transformedAt: new Date().toISOString(),
        transformerVersion: this.version,
      },
      contents: { ...bundle.contents },
    };

    // Apply transformations based on target capabilities
    if (transformed.contents.instructions) {
      const content = transformed.contents.instructions.content;
      if (content.length > targetCaps.instructionLimit) {
        if (options.overflowStrategy === 'truncate') {
          transformed.contents.instructions = {
            ...transformed.contents.instructions,
            content: content.substring(0, targetCaps.instructionLimit - 3) + '...',
            length: targetCaps.instructionLimit,
          };
        } else if (options.overflowStrategy === 'summarize') {
          // Mock summarization - just truncate with a note
          transformed.contents.instructions = {
            ...transformed.contents.instructions,
            content: `[Summarized for ${targetCaps.name}]\n\n` +
              content.substring(0, targetCaps.instructionLimit - 50),
            length: targetCaps.instructionLimit,
          };
        }
      }
    }

    // Handle memories if target doesn't support them
    if (!targetCaps.hasMemory && transformed.contents.memories) {
      // Convert memories to knowledge format (mock)
      transformed.metadata.warnings.push(
        `Converted ${transformed.contents.memories.count} memories to knowledge documents`,
      );
    }

    return transformed;
  }
}
