/**
 * S3-Compatible Storage Backend
 *
 * Works with AWS S3, Cloudflare R2, Backblaze B2, and any S3-compatible service.
 * Uses native fetch() and implements AWS Signature V4 from scratch — zero dependencies.
 *
 * Path-style access only (most compatible across providers).
 */

import { createHmac, createHash } from 'node:crypto';
import type { StorageBackend } from '../types.js';

// ─── Types ───────────────────────────────────────────────────

export interface S3StorageOptions {
  /** S3 bucket name */
  bucket: string;
  /** Endpoint URL (e.g., https://<account>.r2.cloudflarestorage.com) */
  endpoint: string;
  /** AWS region (e.g., 'us-east-1', 'auto' for R2) */
  region?: string;
  /** AWS access key ID */
  accessKeyId?: string;
  /** AWS secret access key */
  secretAccessKey?: string;
  /** Optional key prefix (e.g., 'snapshots/') */
  prefix?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Max retries on 5xx errors (default: 3) */
  maxRetries?: number;
}

// ─── Errors ──────────────────────────────────────────────────

export class S3Error extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

// ─── AWS Signature V4 ───────────────────────────────────────

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * Format a Date as YYYYMMDD'T'HHMMSS'Z' (ISO 8601 basic)
 */
function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Format a Date as YYYYMMDD
 */
function toDateStamp(date: Date): string {
  return toAmzDate(date).slice(0, 8);
}

/**
 * URI-encode per AWS spec (RFC 3986 with some extras).
 * Encodes everything except unreserved characters: A-Za-z0-9 _.-~
 */
function uriEncode(str: string, encodeSlash = true): string {
  return str
    .split('')
    .map((ch) => {
      if (
        (ch >= 'A' && ch <= 'Z') ||
        (ch >= 'a' && ch <= 'z') ||
        (ch >= '0' && ch <= '9') ||
        ch === '_' ||
        ch === '-' ||
        ch === '~' ||
        ch === '.'
      ) {
        return ch;
      }
      if (ch === '/' && !encodeSlash) {
        return '/';
      }
      return '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    })
    .join('');
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

interface SignParams {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
  date: Date;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * AWS Signature V4 signing implementation.
 *
 * Steps:
 * 1. Create canonical request
 * 2. Create string to sign
 * 3. Derive signing key (HMAC chain)
 * 4. Calculate signature
 * 5. Build Authorization header
 */
function signRequest(params: SignParams): string {
  const { method, path, query, headers, payloadHash, date, region, accessKeyId, secretAccessKey } =
    params;

  const dateStamp = toDateStamp(date);
  const amzDate = toAmzDate(date);
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;

  // Step 1: Canonical request
  // Sort query string parameters
  const canonicalQueryString = query
    ? Object.keys(query)
        .sort()
        .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
        .join('&')
    : '';

  // Canonical headers: lowercase, sorted, trimmed
  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h.toLowerCase()] ?? headers[h]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    uriEncode(path, false),
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // Step 2: String to sign
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n');

  // Step 3: Signing key (HMAC chain)
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, SERVICE);
  const kSigning = hmacSha256(kService, 'aws4_request');

  // Step 4: Signature
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  // Step 5: Authorization header
  return `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// ─── XML Parsing Helpers ─────────────────────────────────────

function extractXmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1];
}

function extractAllXmlTags(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
}

/**
 * Parse S3 error XML response.
 */
function parseS3ErrorXml(xml: string): { code?: string; message?: string; requestId?: string } {
  return {
    code: extractXmlTag(xml, 'Code'),
    message: extractXmlTag(xml, 'Message'),
    requestId: extractXmlTag(xml, 'RequestId'),
  };
}

// ─── S3 Storage Backend ──────────────────────────────────────

export class S3Storage implements StorageBackend {
  readonly id: string;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly host: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket || this.env('SAVESTATE_S3_BUCKET', '') || '';
    this.endpoint = (options.endpoint || this.env('SAVESTATE_S3_ENDPOINT', 'AWS_ENDPOINT_URL') || '').replace(/\/+$/, '');
    this.region = options.region || this.env('SAVESTATE_S3_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION') || 'auto';
    this.accessKeyId = options.accessKeyId || this.env('SAVESTATE_S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID') || '';
    this.secretAccessKey = options.secretAccessKey || this.env('SAVESTATE_S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY') || '';
    this.prefix = options.prefix ?? '';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;

    // Validate required fields
    if (!this.bucket) {
      throw new Error(
        'S3 storage: bucket is required. Set storage.options.bucket in config or SAVESTATE_S3_BUCKET env var.',
      );
    }
    if (!this.endpoint) {
      throw new Error(
        'S3 storage: endpoint is required. Set storage.options.endpoint in config or SAVESTATE_S3_ENDPOINT env var.\n' +
        '  Examples:\n' +
        '    Cloudflare R2: https://<account_id>.r2.cloudflarestorage.com\n' +
        '    AWS S3:        https://s3.<region>.amazonaws.com\n' +
        '    Backblaze B2:  https://s3.<region>.backblazeb2.com',
      );
    }
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error(
        'S3 storage: credentials are required.\n' +
        '  Set storage.options.accessKeyId/secretAccessKey in config, or env vars:\n' +
        '    SAVESTATE_S3_ACCESS_KEY_ID / AWS_ACCESS_KEY_ID\n' +
        '    SAVESTATE_S3_SECRET_ACCESS_KEY / AWS_SECRET_ACCESS_KEY',
      );
    }

    // Extract host from endpoint
    const url = new URL(this.endpoint);
    this.host = url.host;

    // Determine backend id
    if (this.endpoint.includes('.r2.cloudflarestorage.com')) {
      this.id = 'r2';
    } else if (this.endpoint.includes('.backblazeb2.com')) {
      this.id = 'b2';
    } else if (this.endpoint.includes('.amazonaws.com')) {
      this.id = 's3';
    } else {
      this.id = 's3';
    }
  }

  /**
   * Read from env vars, trying multiple names in order.
   */
  private env(...names: string[]): string {
    for (const name of names) {
      const val = process.env[name];
      if (val) return val;
    }
    return '';
  }

  /**
   * Build the full object key with prefix.
   */
  private fullKey(key: string): string {
    return this.prefix + key;
  }

  /**
   * Execute a signed S3 request with retries.
   */
  private async request(
    method: string,
    objectKey: string,
    options?: {
      body?: Buffer;
      query?: Record<string, string>;
      /** If true, don't throw on 404 — return the response */
      allow404?: boolean;
    },
  ): Promise<Response> {
    const { body, query, allow404 } = options ?? {};
    const path = `/${this.bucket}/${objectKey}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    const payloadHash = body ? sha256(body) : sha256('');

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 200ms, 400ms, 800ms...
        const delay = Math.min(200 * Math.pow(2, attempt - 1), 5000);
        await new Promise((r) => setTimeout(r, delay));
      }

      const now = new Date();
      const amzDate = toAmzDate(now);

      // Build headers (lowercase keys for canonical request)
      const headers: Record<string, string> = {
        host: this.host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
      };

      if (body) {
        headers['content-length'] = String(body.length);
      }

      // Sign the request
      const authorization = signRequest({
        method,
        path,
        query,
        headers,
        payloadHash,
        date: now,
        region: this.region,
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      });

      headers['authorization'] = authorization;

      // Build URL with query string
      let url = `${this.endpoint}${path}`;
      if (query && Object.keys(query).length > 0) {
        const qs = Object.entries(query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&');
        url += `?${qs}`;
      }

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body ?? undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        // Retry on 5xx server errors
        if (response.status >= 500 && attempt < this.maxRetries) {
          lastError = new S3Error(
            `S3 server error (${response.status})`,
            response.status,
          );
          continue;
        }

        // Handle 404 — return response if allowed, otherwise throw
        if (response.status === 404) {
          if (allow404) return response;
          const text = await response.text();
          const err = parseS3ErrorXml(text);
          throw new S3Error(
            `Object not found: ${objectKey}` + (err.code ? ` (${err.code})` : ''),
            404,
            err.code ?? 'NoSuchKey',
            err.requestId,
          );
        }

        // Handle other errors
        if (!response.ok) {
          const text = await response.text();
          const err = parseS3ErrorXml(text);
          const msg =
            err.message ?? `S3 request failed: ${method} ${path} → ${response.status}`;
          throw new S3Error(msg, response.status, err.code, err.requestId);
        }

        return response;
      } catch (error: unknown) {
        if (error instanceof S3Error) throw error;

        // Network/timeout errors — retry if possible
        if (attempt < this.maxRetries) {
          lastError =
            error instanceof Error ? error : new Error(String(error));
          continue;
        }

        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new S3Error(
            `S3 request timed out after ${this.timeoutMs}ms: ${method} ${path}`,
            0,
            'TimeoutError',
          );
        }

        throw error;
      }
    }

    // Should not reach here, but just in case
    throw lastError ?? new Error('S3 request failed after retries');
  }

  // ─── StorageBackend Interface ────────────────────────────

  async put(key: string, data: Buffer): Promise<void> {
    await this.request('PUT', this.fullKey(key), { body: data });
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.request('GET', this.fullKey(key));
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async list(prefix?: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const query: Record<string, string> = {
        'list-type': '2',
      };

      // Combine storage prefix with caller's prefix
      const fullPrefix = this.prefix + (prefix ?? '');
      if (fullPrefix) {
        query['prefix'] = fullPrefix;
      }

      if (continuationToken) {
        query['continuation-token'] = continuationToken;
      }

      // List is on the bucket root path
      const response = await this.request('GET', '', { query });
      const xml = await response.text();

      // Extract keys from XML
      const rawKeys = extractAllXmlTags(xml, 'Key');

      // Strip the storage prefix from keys so callers see relative paths
      for (const rawKey of rawKeys) {
        if (this.prefix && rawKey.startsWith(this.prefix)) {
          keys.push(rawKey.slice(this.prefix.length));
        } else {
          keys.push(rawKey);
        }
      }

      // Check for pagination
      const isTruncated = xml.includes('<IsTruncated>true</IsTruncated>');
      if (isTruncated) {
        continuationToken = extractXmlTag(xml, 'NextContinuationToken');
      } else {
        continuationToken = undefined;
      }
    } while (continuationToken);

    return keys;
  }

  async delete(key: string): Promise<void> {
    await this.request('DELETE', this.fullKey(key));
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.request('HEAD', this.fullKey(key), {
      allow404: true,
    });
    return response.status !== 404;
  }
}
