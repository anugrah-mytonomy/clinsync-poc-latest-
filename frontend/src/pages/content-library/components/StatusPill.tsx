import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export type PillTone = 'success' | 'danger' | 'warning' | 'info' | 'muted';

const toneClasses: Record<PillTone, string> = {
  success: 'border-success/20 bg-success/10 text-success',
  danger: 'border-danger/20 bg-danger/10 text-danger',
  warning: 'border-amber-300 bg-amber-50 text-amber-700',
  info: 'border-primary/20 bg-primary/10 text-primary',
  muted: 'border-border bg-surface text-muted',
};

/** Small rounded status label — Ready / Rejected / Duplicate / In library / From this upload. */
const StatusPill = ({ tone, children }: { tone: PillTone; children: ReactNode }) => (
  <span
    className={cn(
      'inline-flex items-center gap-xs whitespace-nowrap rounded-full border px-sm py-[2px] text-xs font-medium',
      toneClasses[tone],
    )}
  >
    {children}
  </span>
);

export default StatusPill;
