/** "Step 1 of 2: Upload Documents" pill in the step header. */
const StepBadge = ({ step, label }: { step: 1 | 2; label: string }) => (
  <span className="inline-flex items-center whitespace-nowrap rounded-full border border-primary/20 bg-primary/10 px-md py-xs text-xs font-medium text-primary">
    Step {step} of 2: {label}
  </span>
);

export default StepBadge;
