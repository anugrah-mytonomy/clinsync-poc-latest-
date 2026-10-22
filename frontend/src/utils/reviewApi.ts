/**
 * Batch review and commit — GET /api/v1/uploads/batches/{id}, POST …/commit (upload-ingest-merge U7, U8).
 */
import type { ServerFileStatus } from '@/utils/statusMapping';

const API_BASE = import.meta.env.VITE_SCAN_API_URL;

export interface BatchFile extends ServerFileStatus {
  file_id: string;
  file_name: string;
  attempt_count: number;
  detected_type: string | null;
}

export interface BatchStatus {
  batch_id: string;
  files: BatchFile[];
  ready_to_add: number;
  pending_review: number;
  in_progress: number;
}

export interface StagedCandidate {
  staged_id: string;
  source_file_id: string;
  source_entry_name: string | null;
  entry_index: number | null;
  file_name: string;
  status: 'processed' | 'rejected';
  reject_reason: string | null;
  content_hash: string | null;
  duplicate_of: { document_id: string; title: string; kind: 'same_content' | 'same_title' } | null;
}

export interface CommitResult {
  added: number;
  skipped: { staged_id: string; file_name: string; reason: string }[];
  still_in_progress: number;
  documents: string[];
  /** Library documents moved to a new version (Replace); absent when none. */
  replaced?: { document_id: string; version: number; previous_version: number }[];
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    let message = `${what} failed (HTTP ${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body?.error?.message === 'string') message = body.error.message;
    } catch {
      // not JSON — keep the generic message
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function fetchBatch(batchId: string): Promise<BatchStatus> {
  return readJson(await fetch(`${API_BASE}/api/v1/uploads/batches/${batchId}`), 'Loading the batch');
}

export async function commitBatch(batchId: string): Promise<CommitResult> {
  return readJson(
    await fetch(`${API_BASE}/api/v1/uploads/batches/${batchId}/commit`, { method: 'POST' }),
    'Adding to the library',
  );
}

const COMMIT_RETRY_MS = 2000;
const COMMIT_MAX_WAIT_MS = 120_000;

/**
 * Confirm & Continue: commit, and while files are still processing (still_in_progress > 0) commit again every ~2 s,
 * for up to ~120 s. Returns everything the calls added, replaced and skipped, and what was still processing at the end.
 */
export async function commitBatchWhenReady(
  batchId: string,
  { retryMs = COMMIT_RETRY_MS, maxWaitMs = COMMIT_MAX_WAIT_MS }: { retryMs?: number; maxWaitMs?: number } = {},
): Promise<CommitResult> {
  const deadline = Date.now() + maxWaitMs;
  const total: CommitResult = { added: 0, skipped: [], still_in_progress: 0, documents: [], replaced: [] };
  for (;;) {
    const result = await commitBatch(batchId);
    total.added += result.added;
    total.skipped.push(...result.skipped);
    total.documents.push(...result.documents);
    total.replaced!.push(...(result.replaced ?? []));
    total.still_in_progress = result.still_in_progress;
    if (result.still_in_progress === 0 || Date.now() + retryMs > deadline) return total;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}
