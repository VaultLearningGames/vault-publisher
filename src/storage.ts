import type { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectHeaders } from './paths.ts';

export interface StoredObject {
  key: string;
  size: number;
}

export interface BrowseResult {
  folders: string[];                                       // full prefixes ending in "/"
  files: { key: string; size: number; modified: string | null }[];
  next?: string;                                           // continuation token for the next page
}

export interface Storage {
  // A URL the caller can PUT one file to, valid for `expiresIn` seconds. The caller must send
  // exactly the headers returned by requestHeaders() for the same ObjectHeaders.
  presignPut(key: string, headers: ObjectHeaders, expiresIn: number): Promise<string>;
  list(prefix: string): Promise<StoredObject[]>;
  deleteKeys(keys: string[]): Promise<void>;
  // One folder level under `prefix` (like a file browser), up to 1000 entries per page.
  browse(prefix: string, token?: string): Promise<BrowseResult>;
  // Streams one object's body; used to copy approved builds from staging to production.
  get(key: string): Promise<Readable | Uint8Array>;
  put(key: string, body: Readable | Uint8Array, size: number, headers: ObjectHeaders): Promise<void>;
}

// Folder-style listing over a plain key→size map; used by in-memory storage in tests and the dev preview.
export function browseKeys(objects: Iterable<[string, number]>, prefix: string): BrowseResult {
  const folders = new Set<string>();
  const files: BrowseResult['files'] = [];
  for (const [key, size] of objects) {
    if (!key.startsWith(prefix) || key === prefix) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) files.push({ key, size, modified: null });
    else folders.add(prefix + rest.slice(0, slash + 1));
  }
  return { folders: [...folders].sort(), files: files.sort((a, b) => a.key.localeCompare(b.key)) };
}

export function requestHeaders(headers: ObjectHeaders): Record<string, string> {
  const out: Record<string, string> = {
    'Content-Type': headers.contentType,
    'Cache-Control': headers.cacheControl,
  };
  if (headers.contentEncoding) out['Content-Encoding'] = headers.contentEncoding;
  return out;
}

export function createR2Storage(opts: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}): Storage {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    forcePathStyle: true,
    // Newer SDKs add CRC32 checksums to presigned PUTs by default, which R2 presigned URLs reject.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const bucket = opts.bucket;

  return {
    presignPut(key, headers, expiresIn) {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: headers.contentType,
        ContentEncoding: headers.contentEncoding,
        CacheControl: headers.cacheControl,
      });
      // Sign the headers so an uploader can't change how the file is served.
      const signableHeaders = new Set(['content-type', 'cache-control']);
      if (headers.contentEncoding) signableHeaders.add('content-encoding');
      return getSignedUrl(client, command, { expiresIn, signableHeaders });
    },

    async list(prefix) {
      const objects: StoredObject[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const item of page.Contents ?? []) {
          if (item.Key) objects.push({ key: item.Key, size: item.Size ?? 0 });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },

    async browse(prefix, token) {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token, MaxKeys: 1000 }),
      );
      return {
        folders: (page.CommonPrefixes ?? []).map((p) => p.Prefix!).filter(Boolean),
        files: (page.Contents ?? []).filter((o) => o.Key && o.Key !== prefix).map((o) => ({
          key: o.Key!, size: o.Size ?? 0, modified: o.LastModified ? o.LastModified.toISOString() : null,
        })),
        next: page.IsTruncated ? page.NextContinuationToken : undefined,
      };
    },

    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) throw new Error(`empty body for ${key}`);
      return res.Body as Readable;
    },

    async put(key, body, size, headers) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: size,
          ContentType: headers.contentType,
          ContentEncoding: headers.contentEncoding,
          CacheControl: headers.cacheControl,
        }),
      );
    },

    async deleteKeys(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
    },
  };
}
