import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import Button from '@/components/ui/Button';
import Spinner from '@/components/ui/Spinner';
import {
  AlertIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CloudUploadIcon,
  DocumentIcon,
  TrashIcon,
} from '@/components/ui/icons';
import StatusPill from '@/pages/content-library/components/StatusPill';
import StepBadge from '@/pages/content-library/components/StepBadge';
import {
  activeMembers,
  canUpload,
  groupedKeys,
  isZipItem,
  memberKind,
  rejectReason,
  rowKind,
  summarize,
  zipBlocker,
  type DuplicateGroup,
} from '@/pages/content-library/uploadQueueModel';
import { cn } from '@/utils/cn';
import { formatBytes } from '@/utils/formatBytes';
import type { UploadQueueItem } from '@/types/contentLibrary';

interface AddContentStepProps {
  items: UploadQueueItem[];
  groups: DuplicateGroup[];
  accept: string;
  formats: string[];
  maxUploadBytes: number;
  uploadError?: string;
  isStarting: boolean;
  onFilesSelected: (files: FileList) => void;
  onRemoveItem: (id: string) => void;
  onRemoveZipEntry: (itemId: string, entryPath: string) => void;
  onClearQueue: () => void;
  onUpload: () => void;
  onBack: () => void;
}

const Dropzone = ({
  accept,
  formats,
  maxUploadBytes,
  onFilesSelected,
}: Pick<AddContentStepProps, 'accept' | 'formats' | 'maxUploadBytes' | 'onFilesSelected'>) => {
  const [isDragActive, setIsDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    if (event.dataTransfer.files.length) onFilesSelected(event.dataTransfer.files);
  };
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) onFilesSelected(event.target.files);
    event.target.value = '';
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragActive(true);
      }}
      onDragLeave={() => setIsDragActive(false)}
      onDrop={handleDrop}
      className={cn(
        'flex cursor-pointer flex-col items-center gap-sm rounded-lg border-2 border-dashed bg-background px-lg py-xl text-center transition-colors',
        isDragActive ? 'border-primary bg-primary/5' : 'border-primary/50 hover:bg-primary/5',
      )}
    >
      <CloudUploadIcon className="h-6 w-6 text-slate-700" />
      <p className="text-sm font-semibold text-slate-900">Drag documents here or browse your system</p>
      <p className="text-xs text-muted">
        Supported clinical document formats up to <span className="font-medium text-primary">{formatBytes(maxUploadBytes)}</span>
      </p>
      <div className="flex flex-wrap justify-center gap-sm">
        {formats.map((format) => (
          <span key={format} className="rounded bg-surface px-sm py-[2px] text-xs font-medium text-slate-700">
            {format}
          </span>
        ))}
      </div>
      <input ref={inputRef} type="file" multiple accept={accept} className="hidden" onChange={handleChange} />
    </div>
  );
};

const RemoveButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    className="rounded-md p-xs text-danger/80 transition-colors hover:bg-danger/10 hover:text-danger"
  >
    <TrashIcon className="h-4 w-4" />
  </button>
);

const FileIcon = ({ danger }: { danger?: boolean }) =>
  danger ? (
    <AlertIcon className="h-5 w-5 shrink-0 text-danger" />
  ) : (
    <DocumentIcon className="h-5 w-5 shrink-0 text-primary" />
  );

const DuplicateGroupPanel = ({
  group,
  onRemoveItem,
  onRemoveZipEntry,
}: {
  group: DuplicateGroup;
  onRemoveItem: (id: string) => void;
  onRemoveZipEntry: (itemId: string, entryPath: string) => void;
}) => (
  <div className="overflow-hidden rounded-lg border border-amber-300 bg-amber-50/40">
    <div className="flex items-center gap-sm border-b border-amber-200 bg-amber-50 px-md py-sm">
      <AlertIcon className="h-4 w-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">Duplicate Group</p>
        <p className="text-xs text-amber-700">
          {group.copies.length} documents in this upload share the same filename.
        </p>
      </div>
    </div>
    {group.copies.map((copy) => (
      <div key={copy.key} className="flex items-center gap-sm border-b border-amber-100 bg-background px-md py-sm last:border-b-0">
        <FileIcon />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900" title={copy.name}>
            {copy.name}
          </p>
          {copy.size !== undefined && <p className="text-xs text-muted">{formatBytes(copy.size)}</p>}
        </div>
        <StatusPill tone="warning">{copy.entryPath ? `From ${copy.origin}` : copy.origin}</StatusPill>
        <RemoveButton
          label={`Remove ${copy.name}`}
          onClick={() => (copy.entryPath ? onRemoveZipEntry(copy.itemId, copy.entryPath) : onRemoveItem(copy.itemId))}
        />
      </div>
    ))}
  </div>
);

const ZipRow = ({
  item,
  grouped,
  onRemoveItem,
  onRemoveZipEntry,
}: {
  item: UploadQueueItem;
  grouped: Set<string>;
  onRemoveItem: (id: string) => void;
  onRemoveZipEntry: (itemId: string, entryPath: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const members = activeMembers(item);
  const blocker = zipBlocker(item, grouped);
  const counts = { ready: 0, rejected: 0, duplicate: 0 };
  for (const entry of members) counts[memberKind(item, entry, grouped)] += 1;

  const needsAttention = counts.rejected > 0 || counts.duplicate > 0;
  const zipStatusLabel = needsAttention ? 'Rejected' : blocker ? 'Action needed' : 'Ready';
  const zipStatusTone = needsAttention ? 'danger' : blocker ? 'warning' : 'success';

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-md px-md py-md">
        <FileIcon />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900" title={item.name}>
            {item.name}
          </p>
          <p className="mt-[2px] text-xs text-muted">
            {formatBytes(item.size)} · {members.length} file{members.length === 1 ? '' : 's'}: {counts.ready} ready
            {counts.duplicate > 0 && ` · ${counts.duplicate} duplicate`}
            {counts.rejected > 0 && ` · ${counts.rejected} rejected`}
          </p>
          {blocker && <p className="mt-[2px] text-xs text-amber-700">{blocker}</p>}
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${item.name}`}
          className="shrink-0 rounded-md p-xs text-muted transition-colors hover:bg-surface hover:text-slate-900"
        >
          <ChevronDownIcon className={cn('h-4 w-4 transition-transform', !open && '-rotate-90')} />
        </button>
        <StatusPill tone={zipStatusTone}>{zipStatusLabel}</StatusPill>
        <RemoveButton label={`Remove ${item.name}`} onClick={() => onRemoveItem(item.id)} />
      </div>

      {open && (
        <ul className="border-t border-border bg-surface/50 py-sm pl-lg pr-md">
          {members.map((entry) => {
            const kind = memberKind(item, entry, grouped);
            return (
              <li key={entry.path} className="flex items-center gap-md py-sm">
                <FileIcon danger={kind === 'rejected'} />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn('truncate text-sm', kind === 'rejected' ? 'text-danger' : 'text-slate-900')}
                    title={entry.path}
                  >
                    {entry.fileName}
                  </p>
                  {kind === 'rejected' && <p className="text-xs text-danger">Rejected — {entry.error}</p>}
                </div>
                <StatusPill tone={kind === 'ready' ? 'success' : kind === 'duplicate' ? 'warning' : 'danger'}>
                  {kind === 'ready' ? 'Ready' : kind === 'duplicate' ? 'Duplicate' : 'Rejected'}
                </StatusPill>
                <RemoveButton label={`Remove ${entry.fileName} from ${item.name}`} onClick={() => onRemoveZipEntry(item.id, entry.path)} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const FileRow = ({ item, onRemoveItem }: { item: UploadQueueItem; onRemoveItem: (id: string) => void }) => {
  const kind = rowKind(item);
  const rejected = kind === 'rejected';
  return (
    <div className="flex items-center gap-sm border-b border-border px-md py-sm last:border-b-0">
      <FileIcon danger={rejected} />
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm font-medium', rejected ? 'text-danger' : 'text-slate-900')} title={item.name}>
          {item.name}
        </p>
        {rejected ? (
          <p className="text-xs text-danger">Rejected — {rejectReason(item)}</p>
        ) : (
          <p className="text-xs text-muted">{formatBytes(item.size)}</p>
        )}
      </div>
      {kind === 'checking' && (
        <StatusPill tone="muted">
          <Spinner className="h-3 w-3 border" label={`Checking ${item.name}`} />
          Checking…
        </StatusPill>
      )}
      {kind === 'ready' && <StatusPill tone="success">Ready</StatusPill>}
      {rejected && <StatusPill tone="danger">Rejected</StatusPill>}
      <RemoveButton label={`Remove ${item.name}`} onClick={() => onRemoveItem(item.id)} />
    </div>
  );
};

/** Add Content: drop files, review the queue (Duplicate Groups on top, Rejected at the bottom), then Upload. */
const AddContentStep = (props: AddContentStepProps) => {
  const { items, groups, onRemoveItem, onRemoveZipEntry } = props;
  const grouped = groupedKeys(groups);
  const summary = summarize(items, groups);
  const listed = items.filter((item) => !grouped.has(item.id));
  const ordered = [
    ...listed.filter((item) => rowKind(item) !== 'rejected'),
    ...listed.filter((item) => rowKind(item) === 'rejected'),
  ];

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Add Content</h1>
          <p className="mt-xs text-sm text-muted">
            Upload healthcare clinical documents to library and verify compliance standards.
          </p>
        </div>
        <StepBadge step={1} label="Upload Documents" />
      </div>

      <Dropzone
        accept={props.accept}
        formats={props.formats}
        maxUploadBytes={props.maxUploadBytes}
        onFilesSelected={props.onFilesSelected}
      />

      {items.length === 0 ? (
        <div>
          <Button variant="secondary" size="sm" onClick={props.onBack}>
            <ChevronLeftIcon className="h-4 w-4" />
            Back to Library
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-md">
            <h2 className="text-sm font-semibold text-slate-900">Uploaded Documents ({items.length})</h2>
            {groups.map((group) => (
              <DuplicateGroupPanel
                key={group.name.toLowerCase()}
                group={group}
                onRemoveItem={onRemoveItem}
                onRemoveZipEntry={onRemoveZipEntry}
              />
            ))}
            {ordered.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-border bg-background">
                {ordered.map((item) =>
                  isZipItem(item) && rowKind(item) === 'ready' ? (
                    <ZipRow
                      key={item.id}
                      item={item}
                      grouped={grouped}
                      onRemoveItem={onRemoveItem}
                      onRemoveZipEntry={onRemoveZipEntry}
                    />
                  ) : (
                    <FileRow key={item.id} item={item} onRemoveItem={onRemoveItem} />
                  ),
                )}
              </div>
            )}
          </div>

          {props.uploadError && (
            <p role="alert" className="flex items-center gap-sm rounded-lg border border-danger/20 bg-danger/5 px-md py-sm text-sm text-danger">
              <AlertIcon className="h-4 w-4 shrink-0" />
              {props.uploadError}
            </p>
          )}

          <div className="flex items-center justify-between gap-md">
            <p className="text-sm text-muted">
              {summary.accepted} accepted · {summary.duplicate} duplicate · {summary.rejected} rejected
              {summary.checking > 0 && ` · ${summary.checking} checking`}
            </p>
            <div className="flex gap-sm">
              <Button variant="secondary" onClick={props.onClearQueue} disabled={props.isStarting}>
                Clear Queue
              </Button>
              <Button
                onClick={props.onUpload}
                disabled={!canUpload(items, groups) || props.isStarting}
                isLoading={props.isStarting}
              >
                Upload
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default AddContentStep;
