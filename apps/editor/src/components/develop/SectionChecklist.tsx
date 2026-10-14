/**
 * The section checklist of Sync and Copy Settings: one checkbox per section, the warning line under a checked one
 * that has one (masks and Transform are per photo), an optional Check all / Check none, and a footnote.
 */
export function SectionChecklist<S extends string>({
  legend,
  sections,
  labels,
  warnings,
  checked,
  onChange,
  bulk = false,
  footnote,
}: {
  legend: string;
  sections: readonly S[];
  labels: Record<S, string>;
  warnings: Partial<Record<S, string>>;
  checked: readonly S[];
  onChange: (checked: S[]) => void;
  /** Show Check all / Check none. */
  bulk?: boolean;
  footnote?: string;
}) {
  const toggle = (section: S) =>
    onChange(checked.includes(section) ? checked.filter((x) => x !== section) : [...checked, section]);
  const bulkButton =
    'rounded px-1.5 py-0.5 text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent';
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-fg-muted">{legend}</legend>
      {bulk && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => onChange([...sections])} className={bulkButton}>
            Check all
          </button>
          <button type="button" onClick={() => onChange([])} className={bulkButton}>
            Check none
          </button>
        </div>
      )}
      {sections.map((section) => (
        <div key={section}>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={checked.includes(section)} onChange={() => toggle(section)} />
            {labels[section]}
          </label>
          {warnings[section] && checked.includes(section) && (
            <p role="note" className="mt-0.5 ml-6 text-[11px] text-fg-muted">
              {warnings[section]}
            </p>
          )}
        </div>
      ))}
      {footnote && <p className="text-[11px] text-fg-muted">{footnote}</p>}
    </fieldset>
  );
}
