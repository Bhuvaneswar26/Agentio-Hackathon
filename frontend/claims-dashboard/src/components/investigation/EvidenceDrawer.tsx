import { FileText, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { DocumentEvidence, SourceRef } from "../../types";

/** A clickable reference to a place in a document. Clicking it opens the document at that line. */
export function SourceChip({
  source,
  onInspect,
}: {
  source: SourceRef;
  onInspect: (source: SourceRef) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onInspect(source)}
      title={`Open ${source.documentName} at line ${source.line}`}
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 transition hover:bg-sky-100"
    >
      <FileText className="h-3 w-3 shrink-0" />
      <span className="truncate">
        {source.documentName} · line {source.line}
      </span>
    </button>
  );
}

/** Side panel showing a document's full text with the referenced line highlighted. */
export function EvidenceDrawer({
  doc,
  line,
  onClose,
}: {
  doc: DocumentEvidence | null;
  line?: number;
  onClose: () => void;
}) {
  const highlighted = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, onClose]);

  useEffect(() => {
    highlighted.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [doc, line]);

  if (!doc) return null;
  const lines = doc.text.split(/\r?\n/);

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-ink/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-label={`Evidence: ${doc.name}`}
        className="fixed inset-y-0 right-0 z-40 flex w-[min(34rem,100vw)] flex-col border-l border-line bg-white shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-mute">
              {doc.kind.replace("_", " ")} · added by {doc.addedBy}
            </p>
            <h2 className="mt-0.5 truncate text-base font-semibold text-ink">
              {doc.name}
            </h2>
            {line ? (
              <p className="mt-0.5 text-xs text-sky-700">
                Showing line {line}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close evidence"
            className="rounded-lg p-1.5 text-mute transition hover:bg-mist hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <ol className="flex-1 overflow-y-auto py-2 font-mono text-xs">
          {lines.map((text, i) => {
            const n = i + 1;
            const active = n === line;
            return (
              <li
                key={n}
                ref={active ? highlighted : undefined}
                className={`flex gap-3 px-4 py-0.5 ${active ? "bg-amber-100" : "hover:bg-mist/60"}`}
              >
                <span className="w-7 shrink-0 select-none text-right text-mute">
                  {n}
                </span>
                <span className="whitespace-pre-wrap break-words text-ink">
                  {text || " "}
                </span>
              </li>
            );
          })}
        </ol>
      </aside>
    </>
  );
}
