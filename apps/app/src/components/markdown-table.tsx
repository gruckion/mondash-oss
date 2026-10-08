import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { extractTableDataFromElement, tableDataToMarkdown, type ExtraProps } from "streamdown";

export const TableCopyContext = createContext<((text: string) => Promise<void>) | undefined>(undefined);

/** A plain transcript table with native clipboard support and a keyboard-accessible expanded view. */
export function MarkdownTable({ children }: ComponentProps<"table"> & ExtraProps) {
  const copyText = useContext(TableCopyContext);
  const table = useRef<HTMLTableElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (expanded && !dialog.current?.open) dialog.current?.showModal();
  }, [expanded]);

  const copy = async () => {
    if (!table.current) return;
    try {
      const text = tableDataToMarkdown(extractTableDataFromElement(table.current));
      if (copyText) await copyText(text);
      else await navigator.clipboard.writeText(text);
      setError("");
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy the table. Try again.");
    }
  };

  return (
    <div className="markdown-table">
      <div className="markdown-table-actions">
        <button type="button" aria-label={copied ? "Table copied" : "Copy table"} title="Copy table" onClick={copy}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            {copied ? (
              <path d="m5 12 4 4L19 6" />
            ) : (
              <>
                <rect x="4" y="8" width="12" height="13" rx="3" />
                <path d="M8 8V5a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-2" />
              </>
            )}
          </svg>
        </button>
        <button
          type="button"
          aria-label="View table fullscreen"
          title="View table fullscreen"
          aria-expanded={expanded}
          onClick={() => setExpanded(true)}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 4h6v6m0-6-7 7M10 20H4v-6m0 6 7-7" />
          </svg>
        </button>
      </div>
      <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="Table">
        <table ref={table}>{children}</table>
      </div>
      {copied && (
        <span className="markdown-table-announcement" role="status">
          Table copied
        </span>
      )}
      {error && (
        <p className="markdown-table-error" role="alert">
          {error}
        </p>
      )}
      <dialog
        ref={dialog}
        className="markdown-table-dialog"
        aria-label="Expanded table"
        onClose={() => setExpanded(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        {expanded && (
          <>
            <button
              className="markdown-table-close"
              type="button"
              aria-label="Close fullscreen table"
              title="Close fullscreen table"
              onClick={() => dialog.current?.close()}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="m6 6 12 12M6 18 18 6" />
              </svg>
            </button>
            <div className="markdown-table-expanded">
              <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="Expanded table contents">
                <table>{children}</table>
              </div>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
