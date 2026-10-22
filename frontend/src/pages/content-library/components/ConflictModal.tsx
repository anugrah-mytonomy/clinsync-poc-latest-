import { useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import { CloseIcon, DocumentIcon } from '@/components/ui/icons';
import StatusPill from '@/pages/content-library/components/StatusPill';
import { formatBytes } from '@/utils/formatBytes';
import type { LibraryMatchDetail } from '@/utils/contentLibraryUploadApi';

/** A queued file (or ZIP member) whose name is already in the library. */
export interface LibraryConflict {
  key: string;
  itemId: string;
  entryPath?: string;
  fileName: string;
  sizeBytes?: number;
  /** The ZIP a member belongs to; a ZIP member cannot replace (the server refuses it). */
  archiveName?: string;
  existing: LibraryMatchDetail;
}

export type ConflictAction = 'remove' | 'replace';

interface ConflictModalProps {
  conflicts: LibraryConflict[];
  onCancel: () => void;
  onFinish: (choices: Record<string, ConflictAction>) => void;
}

const Field = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-md border-t border-border py-xs text-xs">
    <span className="text-muted">{label}</span>
    <span className="text-right font-medium text-slate-900">{value}</span>
  </div>
);

const ACTIONS: { value: ConflictAction; label: string; help: string }[] = [
  { value: 'remove', label: 'Remove new document', help: 'Keeps the existing library version and its scan history.' },
  {
    value: 'replace',
    label: 'Replace existing document',
    help: 'Supersedes the stored file; the prior version is not retained.',
  },
];

/** Default: replace the library copy; ZIP members cannot replace on the server. */
const defaultConflictAction = (conflict: LibraryConflict): ConflictAction =>
  conflict.archiveName ? 'remove' : 'replace';

/** Walks the user through each library conflict, one at a time; nothing uploads until Accept & Finish. */
const ConflictModal = ({ conflicts, onCancel, onFinish }: ConflictModalProps) => {
  const [index, setIndex] = useState(0);
  const [choices, setChoices] = useState<Record<string, ConflictAction>>(() =>
    Object.fromEntries(conflicts.map((c) => [c.key, defaultConflictAction(c)])),
  );

  useEffect(() => {
    setIndex(0);
    setChoices(Object.fromEntries(conflicts.map((c) => [c.key, defaultConflictAction(c)])));
  }, [conflicts]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const conflict = conflicts[index];
  const choice = choices[conflict.key] ?? defaultConflictAction(conflict);
  const isLast = index === conflicts.length - 1;
  const percent = Math.round(((index + 1) / conflicts.length) * 100);

  const accept = () => {
    const resolved = { ...choices, [conflict.key]: choice };
    setChoices(resolved);
    if (isLast) {
      onFinish(
        Object.fromEntries(conflicts.map((c) => [c.key, resolved[c.key] ?? defaultConflictAction(c)])),
      );
    } else setIndex(index + 1);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-background shadow-xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-md border-b border-border p-lg">
          <div>
            <h2 id="conflict-title" className="text-base font-semibold text-slate-900">
              A document you are uploading is a potential duplicate of an existing document
            </h2>
            <p className="mt-xs text-sm text-muted">Choose which version ClinSync keeps in the library.</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="rounded-md p-xs text-muted hover:bg-surface hover:text-slate-900"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-md overflow-y-auto p-lg">
          <div>
            <p className="text-sm font-semibold text-slate-900">
              Document {index + 1} of {conflicts.length}
            </p>
            <p className="text-xs text-muted">Review each document individually before moving to the next one.</p>
            <div className="mt-sm h-1.5 w-full overflow-hidden rounded-full bg-surface">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
            </div>
            <p className="mt-xs text-xs text-muted">{percent}% complete</p>
          </div>

          <div className="grid gap-md sm:grid-cols-2">
            <div className="rounded-lg border border-border p-md">
              <div className="mb-sm flex items-center justify-between">
                <StatusPill tone="muted">Existing Document</StatusPill>
                <StatusPill tone="success">In library</StatusPill>
              </div>
              <p className="mb-sm flex items-center gap-xs text-sm font-medium text-slate-900">
                <DocumentIcon className="h-4 w-4 text-primary" />
                <span className="truncate">{conflict.fileName}</span>
              </p>
              <Field label="Size" value={formatBytes(conflict.existing.sizeBytes)} />
              <Field label="Upload date" value={new Date(conflict.existing.addedAt).toLocaleDateString()} />
              <Field label="Speciality" value={conflict.existing.specialties.join(", ") || "—"} />
              <Field label="Document Type" value={conflict.existing.documentType ?? "—"} />
            </div>
            <div className="rounded-lg border border-border p-md">
              <div className="mb-sm flex items-center justify-between">
                <StatusPill tone="info">New Document</StatusPill>
                <StatusPill tone="warning">{conflict.archiveName ? `From ${conflict.archiveName}` : 'From this upload'}</StatusPill>
              </div>
              <p className="mb-sm flex items-center gap-xs text-sm font-medium text-slate-900">
                <DocumentIcon className="h-4 w-4 text-primary" />
                <span className="truncate">{conflict.fileName}</span>
              </p>
              <Field label="Size" value={conflict.sizeBytes !== undefined ? formatBytes(conflict.sizeBytes) : '—'} />
              <Field label="Upload date" value="Pending" />
              <Field label="Speciality" value="Assigned after upload" />
              <Field label="Document Type" value="Assigned after upload" />
            </div>
          </div>

          <fieldset className="flex flex-col gap-sm">
            <legend className="mb-sm text-xs font-semibold uppercase tracking-wide text-muted">Action</legend>
            {ACTIONS.map((action) => {
              const disabled = action.value === 'replace' && Boolean(conflict.archiveName);
              return (
                <label
                  key={action.value}
                  className={`flex items-center gap-md rounded-lg border px-md py-sm transition-colors ${
                    choice === action.value ? 'border-primary bg-primary/5' : 'border-border'
                  } ${
                    disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface/60'
                  }`}
                >
                  <input
                    type="radio"
                    name={`action-${conflict.key}`}
                    className="h-4 w-4 shrink-0 accent-primary"
                    disabled={disabled}
                    checked={choice === action.value}
                    onChange={() => setChoices((prev) => ({ ...prev, [conflict.key]: action.value }))}
                  />
                  <span>
                    <span className="block text-sm font-medium text-slate-900">{action.label}</span>
                    <span className="block text-xs text-muted">
                      {disabled ? 'A file inside a ZIP cannot replace a library document.' : action.help}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-border p-lg">
          <Button variant="secondary" onClick={() => setIndex(index - 1)} disabled={index === 0}>
            Back
          </Button>
          <Button onClick={accept}>
            {isLast ? 'Accept & Finish' : 'Accept & Continue'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ConflictModal;
