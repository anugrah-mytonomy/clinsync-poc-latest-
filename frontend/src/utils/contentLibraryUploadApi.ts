/**
 * Content Library Upload API — /clinsync/uploads/* (upload-ingest-merge design.md §5.2a).
 *
 * One Upload click: check-duplicates → batches (once) → per file: initiate (its answer carries a presigned PUT URL
 * for every part — there is no presign call) → PUT every part straight to S3 → complete for that file alone.
 * Retry: discard the failed upload, then initiate again with the same batchId and the same choices.
 * File bytes never pass through the API.
 */
import { S3UploadAborted, S3UploadError, putChunk, sleep } from '@/utils/s3ChunkedUpload';

const API_BASE = import.meta.env.VITE_SCAN_API_URL;
const MAX_CONCURRENT_PARTS = Number(import.meta.env.VITE_UPLOAD_CONCURRENCY) || 4;
const MAX_RETRIES_PER_PART = 3;
const RETRY_BASE_DELAY_MS = 500;

/** An API refusal: the message to show, its status, an optional machine-readable code, and whether Retry helps. */
export class UploadApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(message: string, status: number, code?: string, retryable = true) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const apiUrl = (path: string): string => {
  if (!API_BASE) throw new UploadApiError('VITE_SCAN_API_URL is not configured.', 0, undefined, false);
  return `${API_BASE}/clinsync/uploads${path}`;
};

/** POST JSON; a refusal becomes UploadApiError with `detail` (or `error.message`) as its message. */
async function post<T>(path: string, body: unknown, context: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new S3UploadAborted('Upload canceled.');
    throw new UploadApiError(`${context} failed (connection lost).`, 0);
  }
  if (!response.ok) {
    let message = `${context} failed (HTTP ${response.status}).`;
    let code: string | undefined;
    try {
      const data = await response.json();
      if (typeof data?.detail === 'string') message = data.detail;
      else if (typeof data?.error?.message === 'string') {
        message = data.error.message;
        code = data.error.code;
      }
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new UploadApiError(message, response.status, code);
  }
  return response.json() as Promise<T>;
}

// ── check-duplicates ─────────────────────────────────────────────────────────

export interface DuplicateCheckEntry {
  fileName: string;
  sizeBytes: number;
}

export interface DuplicateCheckFile extends DuplicateCheckEntry {
  /** ZIP only: every file inside it. */
  entries?: DuplicateCheckEntry[];
}

export interface LibraryMatchDetail {
  fileId: string;
  sizeBytes: number;
  addedAt: string;
  version: number;
  specialties: string[];
  documentType: string | null;
}

export interface DuplicateMatch {
  /** Present only when the match is a file inside a ZIP. */
  archiveName?: string;
  fileName: string;
  match: LibraryMatchDetail;
}

/** POST /check-duplicates — library documents with the same file name (any size); [] means no conflicts. */
export async function checkDuplicates(files: DuplicateCheckFile[]): Promise<DuplicateMatch[]> {
  if (files.length === 0) return [];
  return (await post<{ matches: DuplicateMatch[] }>('/check-duplicates', { files }, 'Duplicate check')).matches;
}

// ── batches ──────────────────────────────────────────────────────────────────

/** POST /batches — once per Upload click; every initiate of the click carries the id. */
export async function createBatch(): Promise<string> {
  return (await post<{ batchId: string }>('/batches', {}, 'Starting the upload')).batchId;
}

// ── initiate / complete / discard ────────────────────────────────────────────

/** What initiate needs besides the file; reused unchanged by Retry. */
export interface UploadOptions {
  batchId: string;
  /** The library document this file replaces (conflict modal → Replace existing document). */
  replacesDocumentId?: string;
  /** ZIP only: its Ready members. */
  entries?: DuplicateCheckEntry[];
}

export interface InitiateResult {
  kind: 'document' | 'archive';
  fileId: string;
  uploadId: string;
  partSize: number;
  parts: Record<string, string>;
}

export interface CompleteResult {
  fileId: string;
  status: string;
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
}

const contentTypeOf = (file: File): string => {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'zip') return 'application/zip';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'html' || ext === 'htm') return 'text/html';
  return 'application/octet-stream';
};

/** POST /initiate — registers the file and returns a presigned PUT URL per part. A refusal cannot be retried. */
export async function initiateUpload(file: File, options: UploadOptions, signal?: AbortSignal): Promise<InitiateResult> {
  try {
    return await post<InitiateResult>(
      '/initiate',
      {
        batchId: options.batchId,
        fileName: file.name,
        fileSize: file.size,
        contentType: contentTypeOf(file),
        ...(options.replacesDocumentId ? { replace: true, replacesDocumentId: options.replacesDocumentId } : {}),
        ...(options.entries ? { entries: options.entries } : {}),
      },
      'Upload initiation',
      signal,
    );
  } catch (err) {
    // Duplicate, closed batch, type or size: the server will refuse a retry too — show its message, no Retry.
    if (err instanceof UploadApiError && err.status >= 400 && err.status < 500) {
      throw new UploadApiError(err.message, err.status, err.code, false);
    }
    throw err;
  }
}

/** POST /{fileId}/complete — once per file, as soon as all its parts are in S3. */
export async function completeUpload(
  fileId: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
  signal?: AbortSignal,
): Promise<CompleteResult> {
  try {
    return await post<CompleteResult>(`/${fileId}/complete`, { uploadId, parts }, 'Completing upload', signal);
  } catch (err) {
    // 404 Upload not found: a retry of the same ids cannot help; everything else re-uploads the file.
    if (err instanceof UploadApiError && err.status === 404) {
      throw new UploadApiError(err.message, err.status, err.code, false);
    }
    throw err;
  }
}

/** POST /{fileId}/discard — before a Retry: the failed upload and its row are removed. Best effort. */
export async function discardUpload(fileId: string, uploadId: string): Promise<void> {
  try {
    await post<{ ok: boolean }>(`/${fileId}/discard`, { uploadId }, 'Discarding the failed upload');
  } catch {
    // a leftover failed row is harmless: initiate creates a new one
  }
}

/** One file: initiate → PUT every part (up to 4 at a time, each retried) → complete. */
export class ContentLibraryUploader {
  private readonly file: File;
  private readonly options: UploadOptions;
  private readonly onProgress?: (progress: UploadProgress) => void;
  private readonly onInitiated?: (ids: { fileId: string; uploadId: string }) => void;
  private readonly controller = new AbortController();
  private readonly activeXhrs = new Set<XMLHttpRequest>();
  private ids?: { fileId: string; uploadId: string };

  constructor(
    file: File,
    options: UploadOptions,
    handlers: {
      onProgress?: (progress: UploadProgress) => void;
      onInitiated?: (ids: { fileId: string; uploadId: string }) => void;
    } = {},
  ) {
    this.file = file;
    this.options = options;
    this.onProgress = handlers.onProgress;
    this.onInitiated = handlers.onInitiated;
  }

  /** The server's ids once initiate has answered. */
  get uploadIds(): { fileId: string; uploadId: string } | undefined {
    return this.ids;
  }

  async start(): Promise<CompleteResult> {
    const initiated = await initiateUpload(this.file, this.options, this.controller.signal);
    this.ids = { fileId: initiated.fileId, uploadId: initiated.uploadId };
    this.onInitiated?.(this.ids);

    const numbers = Object.keys(initiated.parts).map(Number).sort((a, b) => a - b);
    const loaded = new Map<number, number>();
    const etags = new Map<number, string>();
    const report = () => {
      const uploadedBytes = [...loaded.values()].reduce((sum, n) => sum + n, 0);
      const totalBytes = this.file.size;
      this.onProgress?.({
        uploadedBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 100,
      });
    };

    const uploadPart = async (n: number) => {
      const blob = this.file.slice((n - 1) * initiated.partSize, n * initiated.partSize);
      for (let attempt = 1; ; attempt += 1) {
        try {
          const etag = await putChunk(
            initiated.parts[String(n)],
            blob,
            this.controller.signal,
            (bytes) => {
              loaded.set(n, bytes);
              report();
            },
            (xhr) => this.activeXhrs.add(xhr),
          );
          etags.set(n, etag);
          return;
        } catch (err) {
          if (err instanceof S3UploadAborted) throw err;
          loaded.set(n, 0);
          if (attempt >= MAX_RETRIES_PER_PART) {
            throw new UploadApiError(
              `Part ${n} failed: ${err instanceof Error ? err.message : String(err)}`,
              0,
              undefined,
              true,
            );
          }
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), this.controller.signal);
        }
      }
    };

    let cursor = 0;
    const worker = async () => {
      while (cursor < numbers.length) {
        const n = numbers[cursor];
        cursor += 1;
        await uploadPart(n);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PARTS, numbers.length) }, worker));

    return completeUpload(
      initiated.fileId,
      initiated.uploadId,
      numbers.map((n) => ({ partNumber: n, etag: etags.get(n) ?? '' })),
      this.controller.signal,
    );
  }

  /** Stops in-flight requests; the server's row is left for discard or the sweepers. */
  cancel(): void {
    this.controller.abort();
    for (const xhr of this.activeXhrs) xhr.abort();
    this.activeXhrs.clear();
  }
}

export { S3UploadAborted, S3UploadError };
