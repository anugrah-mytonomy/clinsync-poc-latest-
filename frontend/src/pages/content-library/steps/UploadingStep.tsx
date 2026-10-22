import Button from '@/components/ui/Button';
import Spinner from '@/components/ui/Spinner';
import { CheckCircleIcon, DocumentIcon, RefreshIcon, XCircleIcon } from '@/components/ui/icons';
import StepBadge from '@/pages/content-library/components/StepBadge';
import { cn } from '@/utils/cn';
import { formatBytes } from '@/utils/formatBytes';
import type { UploadQueueItem } from '@/types/contentLibrary';

export type UploadRowState = 'uploading' | 'done' | 'failed';

export const uploadRowState = (item: UploadQueueItem): UploadRowState => {
  const status = item.cloudUpload?.status;
  if (status === 'success') return 'done';
  if (status === 'failed' || item.status === 'upload-failed' || item.status === 'validation-failed') return 'failed';
  return 'uploading';
};

interface UploadingStepProps {
  items: UploadQueueItem[];
  onRetry: (id: string) => void;
  onContinue: () => void;
}

/** Uploading Documents: per-file progress, Retry on a failed row, Continue to Tagging once every row is settled. */
const UploadingStep = ({ items, onRetry, onContinue }: UploadingStepProps) => {
  const states = items.map(uploadRowState);
  const uploaded = states.filter((s) => s === 'done').length;
  const failed = states.filter((s) => s === 'failed').length;
  const settled = states.every((s) => s !== 'uploading');

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {settled ? 'Upload Complete' : 'Uploading Documents'} ({items.length})
          </h1>
          <p className="mt-xs text-sm text-muted">Please wait while your documents are added to the library.</p>
        </div>
        <StepBadge step={1} label="Upload Documents" />
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-background">
        {items.map((item, i) => {
          const state = states[i];
          const isFailed = state === 'failed';
          const canRetry = isFailed && item.cloudUpload?.retryable !== false;
          return (
            <div
              key={item.id}
              className={cn(
                'flex items-center gap-sm border-b border-border px-md py-sm last:border-b-0',
                isFailed && 'bg-danger/10',
              )}
            >
              <DocumentIcon className={cn('h-5 w-5 shrink-0', isFailed ? 'text-danger' : 'text-primary')} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900" title={item.name}>
                  {item.name}
                </p>
                <p className="text-xs text-muted">
                  {formatBytes(item.size)}
                  {isFailed && item.cloudUpload?.error && ` · ${item.cloudUpload.error}`}
                </p>
              </div>
              {state === 'uploading' && (
                <span className="flex items-center gap-xs text-xs font-medium text-primary">
                  <Spinner className="h-3.5 w-3.5 border" label={`Uploading ${item.name}`} />
                  Uploading… {Math.round(item.cloudUpload?.percent ?? 0)}%
                </span>
              )}
              {state === 'done' && (
                <span className="flex items-center gap-xs text-xs font-medium text-success">
                  <CheckCircleIcon className="h-4 w-4" />
                  Uploaded successfully
                </span>
              )}
              {isFailed && (
                <span className="flex items-center gap-sm">
                  <span className="flex items-center gap-xs text-xs font-medium text-danger">
                    <XCircleIcon className="h-4 w-4" />
                    Upload Failed
                  </span>
                  {canRetry && (
                    <Button variant="secondary" size="sm" onClick={() => onRetry(item.id)}>
                      <RefreshIcon className="h-3.5 w-3.5" />
                      Retry
                    </Button>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-md">
        <p className="text-sm text-muted">
          {uploaded} uploaded · {failed} failed
        </p>
        <Button onClick={onContinue} disabled={!settled || uploaded === 0}>
          Continue to Tagging
        </Button>
      </div>
    </div>
  );
};

export default UploadingStep;
