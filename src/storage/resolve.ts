/**
 * Storage Backend Resolver
 *
 * Creates a storage backend instance from config.
 */

import type { SaveStateConfig, StorageBackend } from '../types.js';
import { LocalStorageBackend } from './local.js';
import { S3Storage } from './s3.js';
import type { S3StorageOptions } from './s3.js';

/**
 * Create a storage backend from the config's storage section.
 */
export function resolveStorage(config: SaveStateConfig): StorageBackend {
  const { type, options } = config.storage;

  switch (type) {
    case 'local':
      return new LocalStorageBackend({
        path: options.path as string | undefined,
      });

    case 's3':
    case 'r2':
    case 'b2':
      return new S3Storage({
        bucket: options.bucket as string,
        endpoint: options.endpoint as string,
        region: options.region as string | undefined,
        accessKeyId: options.accessKeyId as string | undefined,
        secretAccessKey: options.secretAccessKey as string | undefined,
        prefix: options.prefix as string | undefined,
        timeoutMs: options.timeoutMs as number | undefined,
        maxRetries: options.maxRetries as number | undefined,
      } satisfies S3StorageOptions);

    default:
      throw new Error(
        `Unknown storage backend: ${type}. ` +
        `Supported: local, s3, r2, b2.`,
      );
  }
}
