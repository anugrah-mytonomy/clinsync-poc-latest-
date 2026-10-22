import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/utils/cn';
import { ChevronDownIcon } from '@/components/ui/icons';

interface MultiSelectProps {
  options: readonly string[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  label: string;
  /** Highlights the control (amber) while nothing is selected. */
  highlightEmpty?: boolean;
  className?: string;
}

/** Dropdown of checkboxes; the button shows the chosen values or the placeholder. */
const MultiSelect = ({
  options,
  value,
  onChange,
  placeholder,
  label,
  highlightEmpty = false,
  className,
}: MultiSelectProps) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const isEmpty = value.length === 0;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = (option: string) =>
    onChange(value.includes(option) ? value.filter((v) => v !== option) : [...value, option]);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex w-full items-center justify-between gap-sm rounded-md border px-sm py-[6px] text-left text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          isEmpty && highlightEmpty
            ? 'border-amber-400 bg-amber-50 text-amber-700'
            : 'border-border bg-background text-slate-900 hover:border-slate-300',
        )}
      >
        <span className="truncate" title={isEmpty ? undefined : value.join(', ')}>
          {isEmpty ? placeholder : value.join(', ')}
        </span>
        <ChevronDownIcon className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          className="absolute left-0 right-0 z-20 mt-xs max-h-60 overflow-auto rounded-md border border-border bg-background py-xs shadow-lg"
        >
          {options.map((option) => {
            const selected = value.includes(option);
            return (
              <li key={option} role="option" aria-selected={selected}>
                <label className="flex cursor-pointer items-center gap-sm px-sm py-[6px] text-xs text-slate-900 hover:bg-surface">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggle(option)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  {option}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default MultiSelect;
