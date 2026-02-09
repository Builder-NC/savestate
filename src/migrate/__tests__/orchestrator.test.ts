/**
 * Migration Orchestrator Tests
 *
 * Tests for the three-phase migration architecture:
 * Extract → Transform → Load
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MigrationOrchestrator, type MigrationEvent } from '../orchestrator.js';
import { registerMockPlugins, MockExtractor, MockLoader } from '../testing/index.js';
import type { MigrationState, MigrationBundle } from '../types.js';

describe('MigrationOrchestrator', () => {
  let testWorkDir: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testWorkDir = join(tmpdir(), `savestate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testWorkDir, { recursive: true });

    // Register mock plugins
    registerMockPlugins();
  });

  afterEach(async () => {
    // Clean up test directory
    if (existsSync(testWorkDir)) {
      await rm(testWorkDir, { recursive: true, force: true });
    }
  });

  describe('Basic Migration Flow', () => {
    it('should complete a full migration between two mock platforms', async () => {
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-1'),
      });

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      expect(result.loaded.instructions).toBe(true);
      expect(result.loaded.memories).toBeGreaterThan(0);

      const state = orchestrator.getState();
      expect(state.phase).toBe('complete');
      expect(state.completedAt).toBeDefined();
    });

    it('should track progress during migration', async () => {
      // Register mock plugins with delays to generate progress events
      registerMockPlugins({
        extractors: { chatgpt: { delayMs: 100 } },
        transformers: { 'chatgpt->claude': { delayMs: 100 } },
        loaders: { claude: { delayMs: 100 } },
      });

      const progressEvents: MigrationEvent[] = [];

      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-2'),
      });

      orchestrator.on((event) => {
        if (event.type === 'progress') {
          progressEvents.push(event);
        }
      });

      await orchestrator.run();

      // Should have progress events from all three phases
      expect(progressEvents.length).toBeGreaterThan(0);

      // Progress should increase monotonically
      let lastProgress = 0;
      for (const event of progressEvents) {
        expect(event.progress).toBeGreaterThanOrEqual(lastProgress);
        lastProgress = event.progress ?? 0;
      }
    });

    it('should emit phase events', async () => {
      const phaseEvents: MigrationEvent[] = [];

      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-3'),
      });

      orchestrator.on((event) => {
        if (event.type.startsWith('phase:')) {
          phaseEvents.push(event);
        }
      });

      await orchestrator.run();

      // Should have start and complete events for each phase
      const phaseStarts = phaseEvents.filter((e) => e.type === 'phase:start');
      const phaseCompletes = phaseEvents.filter((e) => e.type === 'phase:complete');

      expect(phaseStarts).toHaveLength(3); // extract, transform, load
      expect(phaseCompletes).toHaveLength(3);
    });
  });

  describe('Checkpoint/Resume Capability', () => {
    it('should save checkpoints after each phase', async () => {
      const workDir = join(testWorkDir, 'migration-4');
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', { workDir });

      await orchestrator.run();

      const state = orchestrator.getState();
      expect(state.checkpoints).toHaveLength(3);
      expect(state.checkpoints[0].phase).toBe('extracting');
      expect(state.checkpoints[1].phase).toBe('transforming');
      expect(state.checkpoints[2].phase).toBe('loading');

      // Verify checkpoint files exist
      for (const checkpoint of state.checkpoints) {
        expect(existsSync(checkpoint.dataPath)).toBe(true);
      }
    });

    it('should persist state to disk', async () => {
      const workDir = join(testWorkDir, 'migration-5');
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', { workDir });

      await orchestrator.run();

      // Read state from disk
      const statePath = join(workDir, 'state.json');
      expect(existsSync(statePath)).toBe(true);

      const savedState = JSON.parse(await readFile(statePath, 'utf-8')) as MigrationState;
      expect(savedState.phase).toBe('complete');
      expect(savedState.id).toBe(orchestrator.getState().id);
    });

    it('should resume a migration from checkpoint', async () => {
      const workDir = join(testWorkDir, 'migration-6');

      // Create an orchestrator and run only extract phase
      const orchestrator1 = new MigrationOrchestrator('chatgpt', 'claude', { workDir });
      await orchestrator1.extract();

      const migrationId = orchestrator1.getState().id;

      // Resume from the checkpoint
      const orchestrator2 = await MigrationOrchestrator.resume(migrationId, workDir);
      const result = await orchestrator2.continue();

      expect(result.success).toBe(true);
      expect(orchestrator2.getState().phase).toBe('complete');
    });

    it('should verify checkpoint integrity with checksums', async () => {
      const workDir = join(testWorkDir, 'migration-7');
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', { workDir });

      await orchestrator.run();

      const state = orchestrator.getState();

      // Each checkpoint should have a checksum
      for (const checkpoint of state.checkpoints) {
        expect(checkpoint.checksum).toBeDefined();
        expect(checkpoint.checksum.length).toBe(64); // SHA-256 hex
      }
    });
  });

  describe('Dry Run', () => {
    it('should not load data in dry run mode', async () => {
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-8'),
        dryRun: true,
      });

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      expect(result.warnings).toContain('Dry run - no changes made');
    });
  });

  describe('Error Handling', () => {
    it('should handle extraction failures', async () => {
      // Register a failing extractor
      registerMockPlugins({
        extractors: {
          chatgpt: { shouldFail: true, failureMessage: 'Auth failed' },
        },
      });

      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-9'),
      });

      await expect(orchestrator.run()).rejects.toThrow('Auth failed');

      const state = orchestrator.getState();
      expect(state.phase).toBe('failed');
      expect(state.error).toBe('Auth failed');
    });

    it('should handle transformation failures', async () => {
      registerMockPlugins({
        transformers: {
          'chatgpt->claude': { shouldFail: true, failureMessage: 'Transform error' },
        },
      });

      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-10'),
      });

      await expect(orchestrator.run()).rejects.toThrow('Transform error');

      const state = orchestrator.getState();
      expect(state.phase).toBe('failed');
    });

    it('should handle load failures', async () => {
      registerMockPlugins({
        loaders: {
          claude: { shouldFail: true, failureMessage: 'Load error' },
        },
      });

      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-11'),
      });

      await expect(orchestrator.run()).rejects.toThrow('Load error');

      const state = orchestrator.getState();
      expect(state.phase).toBe('failed');
    });

    it('should handle extractor auth failure', async () => {
      // Register extractor that fails canExtract()
      registerMockPlugins({
        extractors: {
          chatgpt: { canExtractResult: false },
        },
      });

      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-12'),
      });

      await expect(orchestrator.run()).rejects.toThrow(/Cannot extract from chatgpt/);
    });
  });

  describe('Rollback Support', () => {
    it('should create rollback plan after successful load', async () => {
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-13'),
      });

      await orchestrator.run();

      const plan = orchestrator.getRollbackPlan();
      expect(plan).not.toBeNull();
      expect(plan?.migrationId).toBe(orchestrator.getState().id);
      expect(plan?.executed).toBe(false);
      expect(plan?.actions.length).toBeGreaterThan(0);
    });

    it('should persist rollback plan to disk', async () => {
      const workDir = join(testWorkDir, 'migration-14');
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', { workDir });

      await orchestrator.run();

      const planPath = join(workDir, 'rollback-plan.json');
      expect(existsSync(planPath)).toBe(true);
    });

    it('should report canRollback correctly', async () => {
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-15'),
      });

      // Before run, no rollback available
      expect(orchestrator.canRollback()).toBe(false);

      await orchestrator.run();

      // After successful run, rollback should be available
      expect(orchestrator.canRollback()).toBe(true);
    });

    it('should execute rollback', async () => {
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-16'),
      });

      await orchestrator.run();

      const rollbackResult = await orchestrator.rollback();

      expect(rollbackResult.success).toBe(true);
      expect(rollbackResult.succeeded.length).toBeGreaterThan(0);

      // Rollback plan should be marked as executed
      const plan = orchestrator.getRollbackPlan();
      expect(plan?.executed).toBe(true);
      expect(plan?.executedAt).toBeDefined();
    });

    it('should prevent double rollback', async () => {
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-17'),
      });

      await orchestrator.run();
      await orchestrator.rollback();

      // Second rollback should fail
      await expect(orchestrator.rollback()).rejects.toThrow('already been executed');
    });

    it('should load rollback plan when resuming', async () => {
      const workDir = join(testWorkDir, 'migration-18');

      const orchestrator1 = new MigrationOrchestrator('chatgpt', 'claude', { workDir });
      await orchestrator1.run();

      const migrationId = orchestrator1.getState().id;

      // Resume and check rollback plan is loaded
      const orchestrator2 = await MigrationOrchestrator.resume(migrationId, workDir);
      expect(orchestrator2.canRollback()).toBe(true);
    });
  });

  describe('Analysis', () => {
    it('should generate compatibility report without full migration', async () => {
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-19'),
      });

      const report = await orchestrator.analyze();

      expect(report.source).toBe('chatgpt');
      expect(report.target).toBe('claude');
      expect(report.summary).toBeDefined();
      expect(report.items.length).toBeGreaterThan(0);
      expect(report.feasibility).toBeDefined();
    });
  });

  describe('Bundle Management', () => {
    it('should save bundle to disk', async () => {
      const workDir = join(testWorkDir, 'migration-20');
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', { workDir });

      await orchestrator.run();

      const bundlePath = join(workDir, 'bundle.json');
      expect(existsSync(bundlePath)).toBe(true);

      const bundle = JSON.parse(await readFile(bundlePath, 'utf-8')) as MigrationBundle;
      expect(bundle.version).toBe('1.0');
      expect(bundle.source.platform).toBe('chatgpt');
      expect(bundle.target?.platform).toBe('claude');
    });

    it('should provide access to bundle via getBundle()', async () => {
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-21'),
      });

      // Before extract, bundle should be null
      expect(orchestrator.getBundle()).toBeNull();

      await orchestrator.run();

      const bundle = orchestrator.getBundle();
      expect(bundle).not.toBeNull();
      expect(bundle?.contents.instructions).toBeDefined();
    });
  });

  describe('Event Handlers', () => {
    it('should allow unsubscribing from events', async () => {
      const events: MigrationEvent[] = [];
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-22'),
      });

      const unsubscribe = orchestrator.on((event) => {
        events.push(event);
      });

      // Unsubscribe
      unsubscribe();

      await orchestrator.run();

      // Should not have received any events
      expect(events).toHaveLength(0);
    });

    it('should not break on handler errors', async () => {
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'migration-23'),
      });

      orchestrator.on(() => {
        throw new Error('Handler error');
      });

      // Should complete despite handler error
      const result = await orchestrator.run();
      expect(result.success).toBe(true);
    });
  });

  describe('Cleanup', () => {
    it('should clean up migration artifacts', async () => {
      const workDir = join(testWorkDir, 'migration-24');
      const orchestrator = new MigrationOrchestrator('chatgpt', 'claude', { workDir });

      await orchestrator.run();
      expect(existsSync(workDir)).toBe(true);

      await orchestrator.cleanup();
      expect(existsSync(workDir)).toBe(false);
    });
  });

  describe('List Migrations', () => {
    it('should list all migrations in the work directory', async () => {
      // Create multiple migrations
      const orchestrator1 = new MigrationOrchestrator('chatgpt', 'claude', {
        workDir: join(testWorkDir, 'mig_test1'),
      });
      await orchestrator1.run();

      const orchestrator2 = new MigrationOrchestrator('claude', 'chatgpt', {
        workDir: join(testWorkDir, 'mig_test2'),
      });
      await orchestrator2.run();

      const migrations = await MigrationOrchestrator.listMigrations(testWorkDir);

      expect(migrations).toHaveLength(2);
      expect(migrations[0].phase).toBe('complete');
      expect(migrations[1].phase).toBe('complete');
    });
  });
});
