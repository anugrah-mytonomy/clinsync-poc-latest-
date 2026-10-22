import JSZip from 'jszip';
import type { UploadQueueItem, ZipEntryResult } from '@/types/contentLibrary';

/** ZIPs are capped at 300 MB (Add Content design §Validation rules); documents use the server's maxUploadBytes. */
export const MAX_ZIP_BYTES = 300 * 1024 * 1024;

export type RowKind = 'checking' | 'ready' | 'rejected';
export type MemberKind = 'ready' | 'rejected' | 'duplicate';

/** One copy inside a Duplicate Group: a loose file, or a member of a ZIP. */
export interface DuplicateCopy {
  key: string;
  itemId: string;
  entryPath?: string;
  name: string;
  size?: number;
  /** "From this upload" for a loose file, the ZIP's name for a ZIP member. */
  origin: string;
}

export interface DuplicateGroup {
  name: string;
  copies: DuplicateCopy[];
}

const baseName = (path: string): string => path.split('/').pop() ?? path;
const nameKey = (name: string): string => baseName(name).trim().toLowerCase();

export const isZipItem = (item: UploadQueueItem): boolean => item.extension === 'zip';

export const rowKind = (item: UploadQueueItem): RowKind => {
  if (item.status === 'validation-failed' || item.validation?.valid === false) return 'rejected';
  if (!item.validated) return 'checking';
  return 'ready';
};

export const rejectReason = (item: UploadQueueItem): string => item.validation?.errors[0] ?? 'Rejected';

/** Members still in the ZIP (the user has not removed them). */
export const activeMembers = (item: UploadQueueItem): ZipEntryResult[] =>
  (item.validation?.zipEntries ?? []).filter((entry) => !entry.excluded);

/**
 * Same-name files of this upload, grouped (case-insensitive, by file name without its folder): loose Ready files and
 * Ready ZIP members together. Only groups of two or more; in the order each group was first seen.
 */
export function buildDuplicateGroups(items: UploadQueueItem[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  const add = (copy: DuplicateCopy) => {
    const k = nameKey(copy.name);
    const group = groups.get(k) ?? { name: baseName(copy.name), copies: [] };
    group.copies.push(copy);
    groups.set(k, group);
  };
  for (const item of items) {
    if (rowKind(item) !== 'ready') continue;
    if (isZipItem(item)) {
      for (const entry of activeMembers(item)) {
        if (!entry.valid) continue;
        add({ key: `${item.id}::${entry.path}`, itemId: item.id, entryPath: entry.path, name: entry.fileName, origin: item.name });
      }
    } else {
      add({ key: item.id, itemId: item.id, name: item.name, size: item.size, origin: 'From this upload' });
    }
  }
  return [...groups.values()].filter((group) => group.copies.length > 1);
}

/** Keys of every copy inside an unresolved Duplicate Group. */
export const groupedKeys = (groups: DuplicateGroup[]): Set<string> =>
  new Set(groups.flatMap((group) => group.copies.map((copy) => copy.key)));

export const memberKind = (item: UploadQueueItem, entry: ZipEntryResult, grouped: Set<string>): MemberKind => {
  if (!entry.valid) return 'rejected';
  return grouped.has(`${item.id}::${entry.path}`) ? 'duplicate' : 'ready';
};

/** Why a ready ZIP cannot upload yet, or null when it can. */
export function zipBlocker(item: UploadQueueItem, grouped: Set<string>): string | null {
  const members = activeMembers(item);
  if (members.some((entry) => !entry.valid)) return 'Remove the rejected files from this ZIP';
  if (members.some((entry) => grouped.has(`${item.id}::${entry.path}`))) return 'Resolve the duplicate files in this ZIP';
  if (!members.some((entry) => entry.valid)) return 'This ZIP has no files left to upload';
  return null;
}

export interface QueueSummary {
  accepted: number;
  duplicate: number;
  rejected: number;
  checking: number;
}

export function summarize(items: UploadQueueItem[], groups: DuplicateGroup[]): QueueSummary {
  const grouped = groupedKeys(groups);
  let accepted = 0;
  let rejected = 0;
  let checking = 0;
  for (const item of items) {
    const kind = rowKind(item);
    if (kind === 'rejected') rejected += 1;
    else if (kind === 'checking') checking += 1;
    else if (!grouped.has(item.id)) accepted += 1;
  }
  return { accepted, duplicate: groups.length, rejected, checking };
}

/** Upload is allowed only when something is Ready, nothing is still being checked, and no group or ZIP is blocking. */
export function canUpload(items: UploadQueueItem[], groups: DuplicateGroup[]): boolean {
  const grouped = groupedKeys(groups);
  const ready = items.filter((item) => rowKind(item) === 'ready');
  if (ready.length === 0 || groups.length > 0) return false;
  if (items.some((item) => rowKind(item) === 'checking')) return false;
  return ready.every((item) => !isZipItem(item) || zipBlocker(item, grouped) === null);
}

/** The ZIP to send: the original file when nothing was removed, otherwise a rebuild with only the kept members. */
export async function prepareZipForUpload(item: UploadQueueItem): Promise<File> {
  const entries = item.validation?.zipEntries ?? [];
  if (!entries.some((entry) => entry.excluded)) return item.file;
  const source = await JSZip.loadAsync(item.file);
  const out = new JSZip();
  for (const entry of entries) {
    if (entry.excluded) continue;
    const file = source.file(entry.path);
    if (file) out.file(entry.path, await file.async('uint8array'));
  }
  const blob = await out.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return new File([blob], item.name, { type: 'application/zip' });
}
