import { useState } from 'react';
import Button from '@/components/ui/Button';
import MultiSelect from '@/components/ui/MultiSelect';
import { AlertIcon, ChevronDownIcon } from '@/components/ui/icons';
import StepBadge from '@/pages/content-library/components/StepBadge';
import { DOCUMENT_TYPE_OPTIONS, SPECIALTY_OPTIONS } from '@/pages/content-library/tagOptions';
import { cn } from '@/utils/cn';

export interface TaggableDocument {
  id: string;
  title: string;
}

export interface DocumentTags {
  specialties: string[];
  documentType: string;
}

interface TagDocumentsStepProps {
  documents: TaggableDocument[];
  isSubmitting: boolean;
  error?: string;
  onConfirm: (tags: Record<string, DocumentTags>) => void;
}

const EMPTY_TAGS: DocumentTags = { specialties: [], documentType: '' };

const DocumentTypeSelect = ({
  value,
  onChange,
  label,
  placeholder,
  highlightEmpty = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  highlightEmpty?: boolean;
}) => (
  <div className="relative">
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        'w-full appearance-none rounded-md border py-[6px] pl-sm pr-lg text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        !value && highlightEmpty
          ? 'border-amber-400 bg-amber-50 text-amber-700'
          : 'border-border bg-background text-slate-900',
      )}
    >
      <option value="">{placeholder}</option>
      {DOCUMENT_TYPE_OPTIONS.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
    <ChevronDownIcon
      className={cn(
        'pointer-events-none absolute right-sm top-1/2 h-3.5 w-3.5 -translate-y-1/2',
        !value && highlightEmpty ? 'text-amber-700' : 'text-slate-600',
      )}
    />
  </div>
);

/** Step 2 — specialty and document type per document (or in bulk), then Confirm & Continue adds them to the library. */
const TagDocumentsStep = ({ documents, isSubmitting, error, onConfirm }: TagDocumentsStepProps) => {
  const [tags, setTags] = useState<Record<string, DocumentTags>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkSpecialties, setBulkSpecialties] = useState<string[]>([]);
  const [bulkType, setBulkType] = useState('');

  const tagsOf = (id: string) => tags[id] ?? EMPTY_TAGS;
  const setTag = (id: string, patch: Partial<DocumentTags>) =>
    setTags((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_TAGS), ...patch } }));

  const allSelected = documents.length > 0 && selected.size === documents.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(documents.map((d) => d.id)));
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const canApply = selected.size > 0 && (bulkSpecialties.length > 0 || bulkType !== '');
  const applyBulk = () => {
    setTags((prev) => {
      const next = { ...prev };
      for (const id of selected) {
        const current = next[id] ?? EMPTY_TAGS;
        next[id] = {
          specialties: bulkSpecialties.length > 0 ? bulkSpecialties : current.specialties,
          documentType: bulkType || current.documentType,
        };
      }
      return next;
    });
    setSelected(new Set());
    setBulkSpecialties([]);
    setBulkType('');
  };

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Tag Documents</h1>
          <p className="mt-xs text-sm text-muted">Confirm the specialty tags and document types for these documents.</p>
        </div>
        <StepBadge step={2} label="Tag Documents" />
      </div>

      <div className="flex flex-wrap items-center gap-sm rounded-lg border border-border bg-background px-md py-sm">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-700">Bulk actions:</span>
        <MultiSelect
          className="min-w-[220px] flex-1"
          options={SPECIALTY_OPTIONS}
          value={bulkSpecialties}
          onChange={setBulkSpecialties}
          placeholder="Specialty (Multi-select)"
          label="Bulk specialty"
        />
        <div className="min-w-[220px] flex-1">
          <DocumentTypeSelect value={bulkType} onChange={setBulkType} label="Bulk document type" placeholder="Document Type" />
        </div>
        <Button variant="secondary" size="sm" onClick={applyBulk} disabled={!canApply}>
          Apply{selected.size > 0 ? ` (${selected.size})` : ''}
        </Button>
      </div>

      <section aria-label="Documents to tag" className="flex flex-col gap-sm">
        <h2 className="text-sm font-semibold text-slate-900">Documents ({documents.length})</h2>
        <div className="overflow-visible rounded-lg border border-border bg-background">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface/60 text-xs font-semibold text-slate-700">
                <th className="w-10 py-sm pl-md">
                  <input
                    type="checkbox"
                    aria-label="Select all documents"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 accent-primary align-middle"
                  />
                </th>
                <th className="py-sm pr-md">Title</th>
                <th className="w-[30%] py-sm pr-md">Specialty</th>
                <th className="w-[30%] py-sm pr-md">Document Type</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const docTags = tagsOf(doc.id);
                return (
                  <tr key={doc.id} className="border-b border-border last:border-b-0">
                    <td className="py-sm pl-md">
                      <input
                        type="checkbox"
                        aria-label={`Select ${doc.title}`}
                        checked={selected.has(doc.id)}
                        onChange={() => toggleOne(doc.id)}
                        className="h-3.5 w-3.5 accent-primary align-middle"
                      />
                    </td>
                    <td className="max-w-0 truncate py-sm pr-md font-medium text-slate-900" title={doc.title}>
                      {doc.title}
                    </td>
                    <td className="py-sm pr-md">
                      <MultiSelect
                        options={SPECIALTY_OPTIONS}
                        value={docTags.specialties}
                        onChange={(specialties) => setTag(doc.id, { specialties })}
                        placeholder="Unassigned"
                        label={`Specialty for ${doc.title}`}
                        highlightEmpty
                      />
                    </td>
                    <td className="py-sm pr-md">
                      <DocumentTypeSelect
                        value={docTags.documentType}
                        onChange={(documentType) => setTag(doc.id, { documentType })}
                        label={`Document type for ${doc.title}`}
                        placeholder="Unassigned"
                        highlightEmpty
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {error && (
        <p role="alert" className="flex items-center gap-sm rounded-lg border border-danger/20 bg-danger/5 px-md py-sm text-sm text-danger">
          <AlertIcon className="h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <Button onClick={() => onConfirm(tags)} isLoading={isSubmitting} disabled={isSubmitting}>
          Confirm &amp; Continue
        </Button>
      </div>
    </div>
  );
};

export default TagDocumentsStep;
