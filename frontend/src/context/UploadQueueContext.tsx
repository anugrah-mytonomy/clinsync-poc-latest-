import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ContentLibraryUploader,
  S3UploadAborted,
  UploadApiError,
  discardUpload,
  type CompleteResult,
} from '@/utils/contentLibraryUploadApi';
import type { CloudUploadState, UploadChoices, UploadQueueItem } from '@/types/contentLibrary';

/**
 * Whole-app upload queue: mounted once in DashboardLayout (which stays alive
 * across every /dashboard/* route since the router only swaps its <Outlet>
 * children) rather than inside a page component. That's what lets an S3
 * upload keep running — and stay visible in <GlobalUploadWidget /> — while
 * the user navigates to a different page; a page-local useState/useRef pair
 * would be torn down on unmount and abandon the upload's UI state (the
 * in-flight XHRs themselves have no relation to React's lifecycle either
 * way, but nothing would be left to show their progress or complete them).
 *
 * Uploads use the Content Library Upload API (/clinsync/uploads/*): about 4 files at a time, each initiate → PUT
 * parts → complete on its own. Retry discards the failed upload and initiates again in the same batch with the
 * same choices.
 */

const MAX_PARALLEL_FILES = Number(import.meta.env.VITE_UPLOAD_CONCURRENCY) || 4;

export const isBlockedFromUpload = (item: UploadQueueItem): boolean =>
  item.status === 'validation-failed' ||
  item.validation?.valid === false ||
  !item.extension ||
  !item.validated;

export const canStartCloudUpload = (item: UploadQueueItem): boolean => {
  if (isBlockedFromUpload(item)) return false;
  const cloud = item.cloudUpload;
  return !cloud || cloud.status === 'idle' || cloud.status === 'failed';
};

interface UploadQueueContextValue {
  items: UploadQueueItem[];
  enqueueItems: (items: UploadQueueItem[]) => void;
  updateItem: (id: string, patch: Partial<UploadQueueItem>) => void;
  /** Queue this row's upload in the batch of its Upload click; choices go with initiate (and with any Retry). */
  startCloudUpload: (item: UploadQueueItem, batchId: string, choices?: UploadChoices) => void;
  retryCloudUpload: (id: string) => void;
  removeItem: (id: string) => void;
  clearItems: (predicate: (item: UploadQueueItem) => boolean) => void;
}

const UploadQueueContext = createContext<UploadQueueContextValue | null>(null);

interface PendingRun {
  id: string;
  run: () => Promise<void>;
}

export const UploadQueueProvider = ({ children }: { children: ReactNode }) => {
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const uploadersRef = useRef(new Map<string, ContentLibraryUploader>());
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const waitingRef = useRef<PendingRun[]>([]);
  const runningRef = useRef(0);

  const patchCloudUpload = useCallback(
    (id: string, updater: (cloudUpload: CloudUploadState) => CloudUploadState) => {
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item;
          if (isBlockedFromUpload(item)) return item;
          const current: CloudUploadState =
            item.cloudUpload ?? { status: 'idle', uploadedBytes: 0, totalBytes: item.size, percent: 0 };
          return { ...item, cloudUpload: updater(current) };
        }),
      );
    },
    [],
  );

  // About MAX_PARALLEL_FILES uploads at a time across the whole queue; the rest wait their turn at 0%.
  const pump = useCallback(() => {
    const drain = () => {
      while (runningRef.current < MAX_PARALLEL_FILES && waitingRef.current.length > 0) {
        const next = waitingRef.current.shift()!;
        runningRef.current += 1;
        void next.run().finally(() => {
          runningRef.current -= 1;
          drain();
        });
      }
    };
    drain();
  }, []);

  const settle = useCallback(
    async (id: string, run: Promise<CompleteResult>) => {
      try {
        const result = await run;
        uploadersRef.current.delete(id);
        patchCloudUpload(id, (cloudUpload) => ({
          ...cloudUpload,
          status: 'success',
          percent: 100,
          uploadedBytes: cloudUpload.totalBytes,
          fileId: result.fileId,
          error: undefined,
        }));
        setItems((prev) =>
          prev.map((item) => (item.id === id && !isBlockedFromUpload(item) ? { ...item, status: 'success' } : item)),
        );
      } catch (err) {
        if (err instanceof S3UploadAborted) return;
        const message = err instanceof Error ? err.message : 'Upload failed.';
        const retryable = !(err instanceof UploadApiError) || err.retryable;
        patchCloudUpload(id, (cloudUpload) => ({ ...cloudUpload, status: 'failed', error: message, retryable }));
        setItems((prev) =>
          prev.map((item) => (item.id === id && !isBlockedFromUpload(item) ? { ...item, status: 'upload-failed' } : item)),
        );
      }
    },
    [patchCloudUpload],
  );

  const queueUpload = useCallback(
    (item: UploadQueueItem, batchId: string, choices: UploadChoices | undefined) => {
      patchCloudUpload(item.id, (cloudUpload) => ({
        ...cloudUpload,
        status: 'uploading',
        uploadedBytes: 0,
        totalBytes: item.file.size,
        percent: 0,
        error: undefined,
        retryable: undefined,
        batchId,
        fileId: undefined,
        uploadId: undefined,
      }));
      waitingRef.current.push({
        id: item.id,
        run: () => {
          if (!itemsRef.current.some((row) => row.id === item.id)) return Promise.resolve(); // removed meanwhile
          const uploader = new ContentLibraryUploader(
            item.file,
            { batchId, ...choices },
            {
              onProgress: (progress) =>
                patchCloudUpload(item.id, (cloudUpload) => ({
                  ...cloudUpload,
                  uploadedBytes: progress.uploadedBytes,
                  totalBytes: progress.totalBytes,
                  percent: progress.percent,
                })),
              onInitiated: ({ fileId, uploadId }) =>
                patchCloudUpload(item.id, (cloudUpload) => ({ ...cloudUpload, fileId, uploadId })),
            },
          );
          uploadersRef.current.set(item.id, uploader);
          return settle(item.id, uploader.start());
        },
      });
      pump();
    },
    [patchCloudUpload, pump, settle],
  );

  const startCloudUpload = useCallback(
    (item: UploadQueueItem, batchId: string, choices?: UploadChoices) => {
      if (isBlockedFromUpload(item)) return;
      setItems((prev) =>
        prev.map((row) => (row.id === item.id ? { ...row, file: item.file, uploadChoices: choices } : row)),
      );
      queueUpload(item, batchId, choices);
    },
    [queueUpload],
  );

  const retryCloudUpload = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((row) => row.id === id);
      const cloud = item?.cloudUpload;
      if (!item || isBlockedFromUpload(item) || !cloud?.batchId) return;
      // Same batch, same choices; no new duplicate check or conflict modal.
      const failed = cloud.fileId && cloud.uploadId ? { fileId: cloud.fileId, uploadId: cloud.uploadId } : null;
      setItems((prev) => prev.map((row) => (row.id === id ? { ...row, status: 'queued' } : row)));
      void (failed ? discardUpload(failed.fileId, failed.uploadId) : Promise.resolve()).then(() =>
        queueUpload(item, cloud.batchId!, item.uploadChoices),
      );
    },
    [queueUpload],
  );

  const cancelCloudUpload = useCallback((id: string) => {
    waitingRef.current = waitingRef.current.filter((pending) => pending.id !== id);
    uploadersRef.current.get(id)?.cancel();
    uploadersRef.current.delete(id);
  }, []);

  const enqueueItems = useCallback((newItems: UploadQueueItem[]) => {
    setItems((prev) => [...prev, ...newItems]);
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<UploadQueueItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const removeItem = useCallback(
    (id: string) => {
      cancelCloudUpload(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    },
    [cancelCloudUpload],
  );

  const clearItems = useCallback(
    (predicate: (item: UploadQueueItem) => boolean) => {
      setItems((prev) => {
        for (const item of prev) if (predicate(item)) cancelCloudUpload(item.id);
        return prev.filter((item) => !predicate(item));
      });
    },
    [cancelCloudUpload],
  );

  const value = useMemo<UploadQueueContextValue>(
    () => ({ items, enqueueItems, updateItem, startCloudUpload, retryCloudUpload, removeItem, clearItems }),
    [items, enqueueItems, updateItem, startCloudUpload, retryCloudUpload, removeItem, clearItems],
  );

  return <UploadQueueContext.Provider value={value}>{children}</UploadQueueContext.Provider>;
};

export const useUploadQueue = (): UploadQueueContextValue => {
  const ctx = useContext(UploadQueueContext);
  if (!ctx) throw new Error('useUploadQueue must be used within a UploadQueueProvider.');
  return ctx;
};
