import { useEffect, useMemo, useState } from 'react';
import PageHeader from '@/components/layout/PageHeader';
import Button from '@/components/ui/Button';
import { UploadIcon } from '@/components/ui/icons';
import StoredUploadsTable from '@/components/ui/uploadFile/StoredUploadsTable';
import { useUploadQueue } from '@/context/UploadQueueContext';
import { UPLOAD_CONFIG as config } from '@/utils/uploadConfig';
import ConflictModal, { type ConflictAction, type LibraryConflict } from '@/pages/content-library/components/ConflictModal';
import AddContentStep from '@/pages/content-library/steps/AddContentStep';
import TagDocumentsStep, { type TaggableDocument } from '@/pages/content-library/steps/TagDocumentsStep';
import UploadingStep, { uploadRowState } from '@/pages/content-library/steps/UploadingStep';
import {
  MAX_ZIP_BYTES,
  activeMembers,
  buildDuplicateGroups,
  isZipItem,
  prepareZipForUpload,
  rowKind,
} from '@/pages/content-library/uploadQueueModel';
import { acceptedFileInput, getFileExtension, getUploadableExtension, validateUploadFile } from '@/utils/contentValidation';
import { formatBytes } from '@/utils/formatBytes';
import { commitBatchWhenReady, type CommitResult } from '@/utils/reviewApi';
import { checkDuplicates, createBatch } from '@/utils/contentLibraryUploadApi';
import { fetchLibraryDocuments, getDownloadUrl, type LibraryDocument } from '@/utils/uploadsApi';
import { toast } from 'react-toastify';
import type { UploadQueueItem } from '@/types/contentLibrary';

type Step = 'library' | 'add' | 'uploading' | 'tagging';

const titleOf = (fileName: string) => (fileName.split('/').pop() ?? fileName).replace(/.[^.]+$/, '');

/** What Confirm & Continue tells the user, from everything the commit calls did. */
const commitMessage = (result: CommitResult): string => {
  const parts = [`Added ${result.added} document${result.added === 1 ? '' : 's'} to the library`];
  if (result.replaced?.length) parts.push(`replaced ${result.replaced.length}`);
  if (result.skipped.length) parts.push(`skipped ${result.skipped.length}`);
  if (result.still_in_progress) parts.push(`${result.still_in_progress} still processing`);
  return `${parts.join(' · ')}.`;
};

let idCounter = 0;
const createItemId = () => {
  idCounter += 1;
  return `upload-item-${Date.now()}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
};

const lower = (name: string) => name.trim().toLowerCase();

/** Content Library: the library table, then Add Content → (conflict modal) → Uploading Documents. */
const ContentLibraryPage = () => {
  const { items: allItems, enqueueItems, updateItem, startCloudUpload, retryCloudUpload, removeItem, clearItems } =
    useUploadQueue();
  const [step, setStep] = useState<Step>('library');
  const [uploadBatchId, setUploadBatchId] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<LibraryConflict[] | null>(null);
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [isStarting, setIsStarting] = useState(false);

  const items = allItems.filter((item) => item.source === 'content-library');
  // Add Content shows what has not been sent yet; Uploading shows the rows of this Upload click.
  const queued = items.filter((item) => !item.cloudUpload || item.cloudUpload.status === 'idle');
  const uploading = items.filter((item) => uploadBatchId && item.cloudUpload?.batchId === uploadBatchId);
  const groups = useMemo(() => buildDuplicateGroups(queued), [queued]);

  const [library, setLibrary] = useState<LibraryDocument[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | undefined>();
  const [libraryVersion, setLibraryVersion] = useState(0);
  useEffect(() => {
    let active = true;
    fetchLibraryDocuments()
      .then((documents) => {
        if (!active) return;
        setLibrary(documents);
        setLibraryError(undefined);
      })
      .catch((err: unknown) => {
        if (active) setLibraryError(err instanceof Error ? err.message : 'Failed to load the library.');
      });
    return () => {
      active = false;
    };
  }, [libraryVersion]);

  // A completed upload rendered here is "acknowledged" — GlobalUploadWidget stops surfacing it elsewhere.
  useEffect(() => {
    for (const item of items) {
      if (item.cloudUpload?.status === 'success' && !item.acknowledgedInWidget) {
        updateItem(item.id, { acknowledgedInWidget: true });
      }
    }
  }, [items, updateItem]);

  const download = async (documentId: string) => {
    try {
      window.location.assign(await getDownloadUrl(documentId));
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : 'Failed to prepare the download.');
    }
  };


  // ── Add Content: local checks on drop; nothing is sent to the server ──────────────────────────────────────
  const reject = (id: string, reason: string) =>
    updateItem(id, { validated: true, validation: { valid: false, errors: [reason] }, status: 'validation-failed' });

  const addFiles = (files: FileList) => {
    const newItems: UploadQueueItem[] = Array.from(files).map((file) => {
      const extension = getUploadableExtension(file.name, config);
      let reason: string | undefined;
      if (!extension) reason = `Unsupported file format (.${getFileExtension(file.name) ?? '?'})`;
      else if (file.size === 0) reason = 'File is empty';
      else if (extension === 'zip' && file.size > MAX_ZIP_BYTES) reason = 'ZIP exceeds the 300 MB limit';
      else if (file.size > config.maxUploadBytes) reason = `File exceeds the ${formatBytes(config.maxUploadBytes)} limit`;
      // Only a ZIP needs its members read (JSZip); every other file is Ready once the rules above pass.
      const needsZipCheck = !reason && extension === 'zip';
      return {
        id: createItemId(),
        file,
        name: file.name,
        extension,
        size: file.size,
        status: reason ? 'validation-failed' : 'queued',
        source: 'content-library',
        validated: !needsZipCheck,
        validation: reason ? { valid: false, errors: [reason] } : needsZipCheck ? undefined : { valid: true, errors: [] },
      };
    });
    enqueueItems(newItems);
    setUploadError(undefined);

    for (const item of newItems) {
      if (item.validated) continue;
      void validateUploadFile(item.file, config)
        .then((result) => {
          if (!result.valid) reject(item.id, result.errors[0] ?? 'Rejected');
          else updateItem(item.id, { validated: true, validation: result, status: 'queued' });
        })
        .catch(() => reject(item.id, 'The file could not be read'));
    }
  };

  const removeZipEntry = (itemId: string, entryPath: string) => {
    const item = items.find((row) => row.id === itemId);
    if (!item?.validation?.zipEntries) return;
    const zipEntries = item.validation.zipEntries.map((entry) =>
      entry.path === entryPath ? { ...entry, excluded: true } : entry,
    );
    updateItem(itemId, { validation: { ...item.validation, zipEntries } });
  };

  // ── Upload: check-duplicates → conflict modal (if any) → POST /batches → per file initiate → S3 → complete ──
  const readyMembers = (item: UploadQueueItem) =>
    activeMembers(item)
      .filter((entry) => entry.valid)
      .map((entry) => ({ fileName: entry.fileName, sizeBytes: entry.size ?? 0 }));

  /** One batch for the click, then every Ready row with its choices; a failed POST /batches leaves the queue as is. */
  const startUploads = async (rows: UploadQueueItem[], replaces: Map<string, string>) => {
    const ready = rows.filter((item) => rowKind(item) === 'ready');
    if (ready.length === 0) return;
    let batchId: string;
    try {
      batchId = await createBatch();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Couldn't start the upload. Please try again.");
      return;
    }
    setUploadBatchId(batchId);
    setStep('uploading');
    for (const item of ready) {
      const file = isZipItem(item) ? await prepareZipForUpload(item) : item.file;
      if (file !== item.file) updateItem(item.id, { file, size: file.size });
      startCloudUpload({ ...item, file, size: file.size }, batchId, {
        replacesDocumentId: replaces.get(item.id),
        entries: isZipItem(item) ? readyMembers(item) : undefined,
      });
    }
  };

  const upload = async () => {
    setUploadError(undefined);
    setIsStarting(true);
    try {
      const ready = queued.filter((item) => rowKind(item) === 'ready');
      const matches = await checkDuplicates(
        ready.map((item) => ({
          fileName: item.name,
          sizeBytes: item.size,
          ...(isZipItem(item) ? { entries: readyMembers(item) } : {}),
        })),
      );
      const found: LibraryConflict[] = [];
      for (const m of matches) {
        if (m.archiveName) {
          const zip = ready.find((item) => isZipItem(item) && item.name === m.archiveName);
          const entry = zip && activeMembers(zip).find((e) => e.valid && lower(e.fileName) === lower(m.fileName));
          if (zip && entry) {
            found.push({ key: `${zip.id}::${entry.path}`, itemId: zip.id, entryPath: entry.path, archiveName: zip.name,
              fileName: entry.fileName, sizeBytes: entry.size, existing: m.match });
          }
        } else {
          const item = ready.find((row) => !isZipItem(row) && lower(row.name) === lower(m.fileName));
          if (item) found.push({ key: item.id, itemId: item.id, fileName: item.name, sizeBytes: item.size, existing: m.match });
        }
      }
      if (found.length > 0) setConflicts(found);
      else await startUploads(queued, new Map());
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Duplicate check failed. Please try again.');
    } finally {
      setIsStarting(false);
    }
  };

  /** Accept & Finish: Remove drops the new copy (or the ZIP member); Replace uploads it with replacesDocumentId. */
  const finishConflicts = (choices: Record<string, ConflictAction>) => {
    const pending = conflicts ?? [];
    setConflicts(null);
    const removedItems = new Set<string>();
    const removedEntries = new Map<string, Set<string>>();
    const replaces = new Map<string, string>();
    for (const conflict of pending) {
      if (choices[conflict.key] === 'replace' && !conflict.entryPath) {
        replaces.set(conflict.itemId, conflict.existing.fileId);
        continue;
      }
      if (choices[conflict.key] !== 'remove') continue;
      if (conflict.entryPath) {
        const set = removedEntries.get(conflict.itemId) ?? new Set<string>();
        set.add(conflict.entryPath);
        removedEntries.set(conflict.itemId, set);
      } else {
        removedItems.add(conflict.itemId);
      }
    }
    for (const id of removedItems) removeItem(id);
    const rows = queued
      .filter((item) => !removedItems.has(item.id))
      .map((item) => {
        const drop = removedEntries.get(item.id);
        if (!drop || !item.validation?.zipEntries) return item;
        const zipEntries = item.validation.zipEntries.map((entry) => (drop.has(entry.path) ? { ...entry, excluded: true } : entry));
        const next = { ...item, validation: { ...item.validation, zipEntries } };
        updateItem(item.id, { validation: next.validation });
        return next;
      })
      .filter((item) => !isZipItem(item) || activeMembers(item).some((entry) => entry.valid));
    void startUploads(rows, replaces);
  };

  // ── Tag Documents: only the files that uploaded; a ZIP contributes each of its members ────────────────────
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | undefined>();
  const taggable = useMemo<TaggableDocument[]>(
    () =>
      uploading
        .filter((item) => uploadRowState(item) === 'done')
        .flatMap((item) =>
          isZipItem(item)
            ? activeMembers(item)
                .filter((entry) => entry.valid)
                .map((entry) => ({ id: `${item.id}::${entry.path}`, title: titleOf(entry.fileName) }))
            : [{ id: item.id, title: titleOf(item.name) }],
        ),
    [uploading],
  );

  const continueToTagging = () => {
    setCommitError(undefined);
    setStep('tagging');
  };

  /** Confirm & Continue: add the batch to the library (tags stay in the UI for now), then straight to the Library. */
  const confirmTags = async () => {
    if (!uploadBatchId) return;
    setIsCommitting(true);
    setCommitError(undefined);
    try {
      const result = await commitBatchWhenReady(uploadBatchId);
      const batchId = uploadBatchId;
      clearItems((item) => item.cloudUpload?.batchId === batchId);
      setUploadBatchId(null);
      setLibraryVersion((version) => version + 1);
      setStep('library');
      toast.success(commitMessage(result));
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Adding to the library failed. Please try again.');
    } finally {
      setIsCommitting(false);
    }
  };

  if (step === 'add') {
    return (
      <div className="flex min-h-full flex-col p-lg">
        <AddContentStep
          items={queued}
          groups={groups}
          accept={acceptedFileInput(config)}
          formats={config.allowedTopLevelExt.map((ext) => ext.toUpperCase())}
          maxUploadBytes={config.maxUploadBytes}
          uploadError={uploadError}
          isStarting={isStarting}
          onFilesSelected={addFiles}
          onRemoveItem={removeItem}
          onRemoveZipEntry={removeZipEntry}
          onClearQueue={() => clearItems((item) => queued.includes(item))}
          onUpload={() => void upload()}
          onBack={() => setStep('library')}
        />
        {conflicts && (
          <ConflictModal conflicts={conflicts} onCancel={() => setConflicts(null)} onFinish={finishConflicts} />
        )}
      </div>
    );
  }

  if (step === 'tagging') {
    return (
      <div className="flex min-h-full flex-col p-lg">
        <TagDocumentsStep
          documents={taggable}
          isSubmitting={isCommitting}
          error={commitError}
          onConfirm={() => void confirmTags()}
        />
      </div>
    );
  }

  if (step === 'uploading') {
    return (
      <div className="flex min-h-full flex-col p-lg">
        <UploadingStep items={uploading} onRetry={retryCloudUpload} onContinue={continueToTagging} />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Content Library"
        subtitle="Patient guidance, training videos, and regulatory materials in your library."
        actions={
          <Button onClick={() => setStep('add')}>
            <UploadIcon className="h-4 w-4" />
            Add Content
          </Button>
        }
      />
      <div className="flex flex-col gap-lg p-lg">
        <div className="rounded-lg border border-border bg-background p-lg">
          <StoredUploadsTable
            documents={library ?? []}
            isLoading={library === null && !libraryError}
            error={libraryError}
            onDownload={(id) => void download(id)}
          />
        </div>
      </div>
    </div>
  );
};

export default ContentLibraryPage;
