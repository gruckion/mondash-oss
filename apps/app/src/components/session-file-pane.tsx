import { useEffect, useRef, useState } from "react";
import type {
  ConversationAttachment,
  ConversationEdit,
  SessionAttachment,
  SessionFiles,
} from "@mondash/shared/contract";
import { DiffCode, FileIcon, SourceCode } from "./source-code";

export type FileSelection = { file: ConversationAttachment; edit?: ConversationEdit };
export type FileLoader = (id: string) => Promise<SessionAttachment>;
export const decodeFile = (file: SessionAttachment) =>
  new TextDecoder().decode(Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0)));

export function SessionFilePane({
  selection,
  load,
  loadFiles,
  close,
  select,
}: {
  selection: FileSelection;
  load: FileLoader;
  loadFiles: () => Promise<SessionFiles>;
  close: () => void;
  select: (value: FileSelection) => void;
}) {
  const [workspace, setWorkspace] = useState<SessionFiles>();
  const [listError, setListError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("");
  const previous = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    return () => previous.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    let active = true;
    void loadFiles().then(
      (result) => {
        if (active) {
          setWorkspace(result);
          setListError("");
        }
      },
      () => {
        if (active) setListError("Could not load the project files.");
      },
    );
    return () => {
      active = false;
    };
  }, [loadFiles, attempt]);
  const file = selection.file;
  const files =
    workspace?.files.filter((entry) => (entry.path ?? entry.name).toLowerCase().includes(filter.toLowerCase())) ?? [];
  const retry = () => setAttempt(attempt + 1);
  return (
    <aside
      ref={panel}
      className="session-file-pane"
      aria-label="Session files"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className="session-file-header">
        <FileIcon name={file.name} />
        <strong>{file.name}</strong>
        <button onClick={close} aria-label="Close file pane">
          ×
        </button>
      </header>
      <div className="session-file-breadcrumbs">
        {workspace?.root && <span>{workspace.root} › </span>}
        {(file.path ?? file.name).split("/").join(" › ")}
        {file.line && <span> · line {file.line}</span>}
      </div>
      <div className="session-file-body">
        <FileViewer key={`${file.id}:${selection.edit?.diff ?? "file"}`} selection={selection} load={load} />
        <nav className="session-file-tree" aria-label="Project files">
          <input
            id="session-file-filter"
            type="search"
            value={filter}
            placeholder="Filter files…"
            aria-label="Filter files"
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="session-file-tree-scroll">
            {listError ? (
              <div role="alert">
                <p>{listError}</p>
                <button onClick={retry}>Try again</button>
              </div>
            ) : !workspace ? (
              <p role="status">Loading folders…</p>
            ) : files.length ? (
              <FileTree
                files={files}
                selected={file.path ?? file.name}
                select={(entry) => select({ file: entry })}
                filtered={!!filter}
              />
            ) : (
              <p>No matching files.</p>
            )}
            {workspace?.truncated && <p>Showing the first 5,000 project files.</p>}
          </div>
        </nav>
      </div>
    </aside>
  );
}
function FileTree({
  files,
  selected,
  select,
  prefix = "",
  filtered,
}: {
  files: readonly ConversationAttachment[];
  selected: string;
  select: (file: ConversationAttachment) => void;
  prefix?: string;
  filtered: boolean;
}) {
  const chosen = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    chosen.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);
  const folders = new Map<string, ConversationAttachment[]>();
  const leaves: ConversationAttachment[] = [];
  for (const file of files) {
    const rest = (file.path ?? file.name).slice(prefix.length);
    const folder = rest.includes("/") ? rest.split("/")[0]! : undefined;
    if (folder) {
      const group = folders.get(folder) ?? [];
      group.push(file);
      folders.set(folder, group);
    } else leaves.push(file);
  }
  return (
    <div className="file-tree-level">
      {[...folders].map(([name, entries]) => (
        <details key={name} open={filtered || selected.startsWith(`${prefix}${name}/`)}>
          <summary>
            <span aria-hidden="true">⌄</span> {name}
          </summary>
          <FileTree
            files={entries}
            selected={selected}
            select={select}
            prefix={`${prefix}${name}/`}
            filtered={filtered}
          />
        </details>
      ))}
      {leaves.map((entry) => (
        <button
          key={entry.id}
          ref={(entry.path ?? entry.name) === selected ? chosen : undefined}
          aria-current={(entry.path ?? entry.name) === selected ? "true" : undefined}
          title={entry.path}
          onClick={() => select(entry)}
        >
          <FileIcon name={entry.name} />
          <span>{entry.name}</span>
        </button>
      ))}
    </div>
  );
}

function FileViewer({ selection, load }: { selection: FileSelection; load: FileLoader }) {
  const [data, setData] = useState<SessionAttachment>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState(selection.edit ? "changes" : "file");
  useEffect(() => {
    let active = true;
    void load(selection.file.id).then(
      (result) => {
        if (active) {
          setData(result);
          setError("");
        }
      },
      (failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "File unavailable");
      },
    );
    return () => {
      active = false;
    };
  }, [selection.file.id, load, attempt]);
  const file = selection.file;
  const text = data?.mediaType.startsWith("text/") ? decodeFile(data) : undefined;
  return (
    <div className="session-file-viewer">
      {selection.edit && (
        <div className="session-file-tabs" role="tablist" aria-label="File view">
          <button role="tab" aria-selected={mode === "changes"} onClick={() => setMode("changes")}>
            Changes <span className="edit-additions">+{selection.edit.additions}</span>{" "}
            <span className="edit-deletions">−{selection.edit.deletions}</span>
          </button>
          <button role="tab" aria-selected={mode === "file"} onClick={() => setMode("file")}>
            Current file
          </button>
        </div>
      )}
      <div className="session-file-content">
        {selection.edit && mode === "changes" ? (
          <DiffCode edit={selection.edit} source={text} />
        ) : error ? (
          <div className="session-file-status" role="alert">
            <p>{error}</p>
            <button onClick={() => setAttempt(attempt + 1)}>Try again</button>
          </div>
        ) : !data ? (
          <p className="session-file-status" role="status">
            Loading file…
          </p>
        ) : text !== undefined ? (
          <SourceCode text={text} name={file.name} line={file.line} />
        ) : (
          <p className="session-file-status">Preview unavailable for this file type.</p>
        )}
      </div>
    </div>
  );
}
