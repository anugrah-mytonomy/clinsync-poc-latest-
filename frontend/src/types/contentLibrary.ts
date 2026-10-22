export type SupportedExtension = 'docx' | 'pdf' | 'html' | 'zip';

export type UploadableExtension = SupportedExtension;

export type UploadStatus = 'queued' | 'success' | 'validation-failed' | 'upload-failed';

export interface VideoSection {
  id: string;
  index: number;
  title: string;
}

export interface ZipEntryResult {
  id: string;
  path: string;
  fileName: string;
  /** Uncompressed size in bytes, sent with check-duplicates and initiate. */
  size?: number;
  valid: boolean;
  error?: string;
  videoSections?: VideoSection[];
  /** The user removed this member on Add Content; it is left out when the ZIP is rebuilt for upload. */
  excluded?: boolean;
}

export interface FileValidationResult {
  valid: boolean;
  errors: string[];
  /** ZIP entries that will not become documents (disallowed type, nested too deeply); the zip still uploads. */
  warnings?: string[];
  videoSections?: VideoSection[];
  zipEntries?: ZipEntryResult[];
}

export type CloudUploadStatus = 'idle' | 'uploading' | 'success' | 'failed' | 'canceled';

/**
 * Progress/result of streaming this file directly to S3 in chunks (see
 * `Client/src/utils/s3ChunkedUpload.ts`).
 */
export interface CloudUploadState {
  status: CloudUploadStatus;
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  error?: string;
  key?: string;
  location?: string;
  /** upload-ingest-merge: the batch of this row's Upload click, and the server's file id once complete. */
  batchId?: string;
  fileId?: string;
  /** The S3 multipart upload id from initiate; sent with complete, and with discard before a Retry. */
  uploadId?: string;
  /** False when the server refused the file (duplicate, closed batch, type, size): no Retry button. */
  retryable?: boolean;
}

/** What initiate sends besides the file — the conflict-modal choice and a ZIP's members; Retry reuses it. */
export interface UploadChoices {
  replacesDocumentId?: string;
  entries?: { fileName: string; sizeBytes: number }[];
}

/** Which page added this item — lets a page show only its own uploads while the queue itself is shared app-wide. */
export type UploadSource = 'content-library';

export interface UploadQueueItem {
  id: string;
  file: File;
  name: string;
  extension: UploadableExtension | null;
  size: number;
  status: UploadStatus;
  source: UploadSource;
  /** Whether the deep "Validate Files" pass has run for this item. */
  validated: boolean;
  validation?: FileValidationResult;
  /** Direct-to-S3 chunked upload progress/result, set for every valid file. */
  cloudUpload?: CloudUploadState;
  /** Set once the user has visited Content Library and seen this upload listed there — GlobalUploadWidget stops showing it once true. */
  acknowledgedInWidget?: boolean;
  /** Set when the Upload click starts this row; Retry sends the same values again. */
  uploadChoices?: UploadChoices;
}
