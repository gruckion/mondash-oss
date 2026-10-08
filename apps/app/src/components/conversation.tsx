"use dom";

import "./conversation.css";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DOMProps } from "expo/dom";
import { IS_DOM } from "expo/dom";
import type {
  ConversationTurn,
  ConversationAttachment,
  SessionAttachment,
  SessionFiles,
  ConversationEdit,
  SessionPullRequest,
} from "@mondash/shared/contract";
import { Markdown } from "./markdown";
import { conversationItems } from "../lib/conversation";
import { SessionFilePane, decodeFile, type FileSelection } from "./session-file-pane";
import { DiffCode, FileIcon } from "./source-code";
import { SessionPRContext, SessionPullRequests } from "./session-pull-requests";
const OpenFile = createContext<(file: ConversationAttachment, edit?: ConversationEdit) => void>(() => {});

export type ConversationTurnView = ConversationTurn;
type AttachmentLoader = (id: string) => Promise<SessionAttachment>;

/** Shared web/iPhone transcript surface, with native actions passed across the DOM bridge. */
export default function Conversation({
  turns,
  title,
  dark,
  note,
  openLink,
  copyText,
  loadAttachment,
  loadFiles,
  running,
  pullRequests = [],
  pullRequestsTruncated,
  pullRequestsError,
  retryPullRequests,
  width,
}: {
  turns: readonly ConversationTurnView[];
  title?: string;
  dark: boolean;
  note?: string;
  openLink: (url: string) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  loadAttachment: AttachmentLoader;
  loadFiles: () => Promise<SessionFiles>;
  running?: boolean;
  pullRequests?: readonly SessionPullRequest[];
  pullRequestsTruncated?: boolean;
  pullRequestsError?: string;
  retryPullRequests?: () => Promise<void>;
  width?: number;
  dom?: DOMProps;
}) {
  const [selection, setSelection] = useState<FileSelection>();
  const root = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const initial = useRef(true);
  const follow = useRef(true);
  useLayoutEffect(() => {
    if (IS_DOM) {
      document.documentElement.style.background = dark ? "#181818" : "#ffffff";
      document.documentElement.style.overflow = "hidden";
      document.documentElement.style.height = "100%";
      document.body.style.margin = "0";
      document.body.style.overflow = "hidden";
      document.body.style.height = "100%";
    }
  }, [dark]);
  useLayoutEffect(() => {
    if (!IS_DOM || !width) return;
    const content = `width=${Math.round(width)}, initial-scale=1`;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) meta.setAttribute("content", content);
    else document.head.insertAdjacentHTML("beforeend", `<meta name="viewport" content="${content}">`);
  }, [width]);
  useEffect(() => {
    const track = (event: Event) => {
      const target = event.target;
      const surface = root.current;
      if (surface && (target === surface || (IS_DOM && target === document)))
        follow.current = surface.scrollHeight - surface.scrollTop - surface.clientHeight < 160;
    };
    document.addEventListener("scroll", track, true);
    return () => document.removeEventListener("scroll", track, true);
  }, []);
  useLayoutEffect(() => {
    if (!initial.current && !follow.current) return;
    initial.current = false;
    end.current?.scrollIntoView({ block: "end", inline: "nearest" });
  }, [turns, width, pullRequests.length]);
  return (
    <OpenFile value={(file, edit) => setSelection({ file, edit })}>
      <SessionPRContext value={{ prs: pullRequests, dark }}>
        <div className={`conversation conversation-workspace${dark ? " dark" : ""}${selection ? " with-file" : ""}`}>
          <div className="conversation-main">
            {title && (
              <header className="conversation-header">
                <h1>{title}</h1>
              </header>
            )}
            <div ref={root} className="conversation-scroll">
              <div className="conversation-transcript">
                {!!note && <p className="conversation-note">{note}</p>}
                {conversationItems(turns).map((item) =>
                  item.kind === "work" ? (
                    <Work
                      key={item.id}
                      turns={item.turns}
                      openLink={openLink}
                      copyText={copyText}
                      loadAttachment={loadAttachment}
                    />
                  ) : (
                    <Turn
                      key={
                        item.turn.activity?.id ?? item.turn.id ?? `${item.turn.role}:${item.turn.at}:${item.turn.text}`
                      }
                      turn={item.turn}
                      openLink={openLink}
                      copyText={copyText}
                      loadAttachment={loadAttachment}
                    />
                  ),
                )}
                {running && (
                  <div className="conversation-working" role="status">
                    <span className="conversation-spinner" />
                    Working…
                  </div>
                )}
                <div ref={end} />
              </div>
            </div>
            <SessionPullRequests
              prs={pullRequests}
              truncated={pullRequestsTruncated}
              error={pullRequestsError}
              retry={retryPullRequests}
              openLink={openLink}
            />
          </div>
          {selection && (
            <SessionFilePane
              selection={selection}
              load={loadAttachment}
              loadFiles={loadFiles}
              close={() => setSelection(undefined)}
              select={setSelection}
            />
          )}
        </div>
      </SessionPRContext>
    </OpenFile>
  );
}

type MessageProps = {
  turn: ConversationTurn;
  openLink: (url: string) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  loadAttachment: AttachmentLoader;
};

function Turn(props: MessageProps) {
  const { turn } = props;
  if (turn.activity) return <ToolActivity turn={turn} />;
  if (turn.context)
    return (
      <details className="conversation-context">
        <summary>
          <span aria-hidden="true">▤</span>
          <span>
            Session context <small>{turn.context}</small>
          </span>
          <span className="conversation-disclosure-chevron" aria-hidden="true">
            ›
          </span>
        </summary>
        <Message {...props} />
      </details>
    );
  return <Message {...props} />;
}

function Work({ turns, ...actions }: Omit<MessageProps, "turn"> & { turns: readonly ConversationTurn[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className="conversation-work" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        {turns.length} previous {turns.length === 1 ? "message" : "messages"}
        <span className="conversation-disclosure-chevron" aria-hidden="true">
          ›
        </span>
      </summary>
      {expanded && (
        <div className="conversation-work-content">
          {turns.map((turn) => (
            <Turn key={turn.activity?.id ?? turn.id ?? `${turn.at}:${turn.text}`} turn={turn} {...actions} />
          ))}
        </div>
      )}
    </details>
  );
}

function Message({ turn, openLink, copyText, loadAttachment }: MessageProps) {
  const openFile = useContext(OpenFile);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string>();
  const body = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || turn.role !== "user" || turn.context) return;
    const measure = () => setOverflows(element.scrollHeight > 360);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [turn.text, turn.role, turn.context]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await copyText(turn.text);
      setError("");
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy. Try again.");
    }
  };
  return (
    <section className={`conversation-turn ${turn.context ? "context" : turn.role}`}>
      {!!turn.attachments?.length && (
        <div className="conversation-attachments">
          {turn.attachments.map((attachment) =>
            attachment.kind === "file" ? (
              !attachment.inline && (
                <button key={attachment.id} className="conversation-file-card" onClick={() => openFile(attachment)}>
                  <FileIcon name={attachment.name} />
                  <span>{attachment.path ?? attachment.name}</span>
                </button>
              )
            ) : (
              <Attachment
                key={attachment.id}
                attachment={attachment}
                load={loadAttachment}
                preview={preview === attachment.id}
                onClose={() => setPreview(undefined)}
              />
            ),
          )}
        </div>
      )}
      {!!turn.text && (
        <div className="conversation-bubble">
          <div
            ref={body}
            className={`conversation-message${turn.role === "user" && !turn.context && !expanded ? " collapsed" : ""}`}
          >
            <Markdown
              text={turn.text}
              copyText={copyText}
              attachments={turn.attachments}
              openLink={async (url) => {
                const id = url.match(/^#mondash-attachment-([a-f0-9]{64})$/)?.[1];
                const file = id ? turn.attachments?.find((attachment) => attachment.id === id) : undefined;
                if (file?.kind === "file") openFile(file);
                else if (file) setPreview(id);
                else await openLink(url);
              }}
            />
          </div>
          {turn.role === "user" && overflows && (
            <button className="conversation-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Show more"}
              <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
            </button>
          )}
        </div>
      )}
      {turn.edits?.map((edit, index) => (
        <EditedFile key={`${edit.file.id}:${index}`} edit={edit} load={loadAttachment} />
      ))}
      <div className="conversation-footer">
        {turn.at && (
          <time dateTime={turn.at} title={new Date(turn.at).toLocaleString()}>
            {new Date(turn.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </time>
        )}
        {!!turn.text && (
          <button
            className="conversation-copy"
            aria-label={copied ? "Message copied" : "Copy message"}
            title={copied ? "Copied" : "Copy message"}
            onClick={() => void copy()}
          >
            <svg
              width="17"
              height="17"
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
                  <rect x="8" y="8" width="12" height="13" rx="3" />
                  <path d="M16 8V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h2" />
                </>
              )}
            </svg>
          </button>
        )}
        {copied && <span role="status">Copied</span>}
        {error && <span role="alert">{error}</span>}
      </div>
    </section>
  );
}

function ToolActivity({ turn }: { turn: ConversationTurn }) {
  const activity = turn.activity!;
  const busy = activity.status === "running";
  const name = activity.name.split(".").at(-1) || activity.name;
  return (
    <details className="conversation-tool">
      <summary>
        {busy ? (
          <span className="conversation-spinner" />
        ) : (
          <span className="conversation-tool-icon" aria-hidden="true">
            ›_
          </span>
        )}
        <span className="conversation-tool-label">
          {busy ? "Running" : activity.status === "interrupted" ? "Interrupted" : "Ran"} {activity.label || name}
        </span>
        <span className="conversation-tool-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="conversation-tool-details">
        <div className="conversation-meta">
          {activity.name} · {activity.status}
        </div>
        {!!activity.input && (
          <pre className="conversation-code">
            <code>{activity.input}</code>
          </pre>
        )}
        {activity.output !== undefined && (
          <>
            <div className="conversation-meta">Output</div>
            <pre className="conversation-code">
              <code>{activity.output || "No output"}</code>
            </pre>
          </>
        )}
      </div>
    </details>
  );
}

function Attachment({
  attachment,
  load,
  preview,
  onClose,
}: {
  attachment: ConversationAttachment;
  load: AttachmentLoader;
  preview?: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<SessionAttachment>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (preview && !dialog.current?.open) dialog.current?.showModal();
  }, [preview]);
  useEffect(() => {
    let active = true;
    void load(attachment.id).then(
      (result) => {
        if (active) {
          setData(result);
          setError("");
        }
      },
      (failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "Attachment unavailable");
      },
    );
    return () => {
      active = false;
    };
  }, [attachment.id, load, attempt]);
  const url = data ? `data:${data.mediaType};base64,${data.data}` : undefined;
  const image = data?.mediaType.startsWith("image/");
  const text = data?.mediaType.startsWith("text/")
    ? new TextDecoder().decode(Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0)))
    : undefined;
  return (
    <div className={`conversation-attachment${attachment.inline ? " inline" : ""}`}>
      {!attachment.inline && (
        <button
          className={`conversation-attachment-card${attachment.kind === "image" ? " image" : ""}`}
          title={error || attachment.name}
          aria-label={`Preview ${attachment.name}`}
          disabled={!data}
          onClick={() => dialog.current?.showModal()}
        >
          {image ? (
            <img src={url} alt={attachment.name} />
          ) : (
            <>
              <span aria-hidden="true">{attachment.kind === "image" ? "▧" : "▤"}</span>
              <span>{attachment.name}</span>
              <small>{error ? "Unavailable" : data ? "Preview file" : "Loading…"}</small>
            </>
          )}
        </button>
      )}
      {error && !attachment.inline && (
        <button
          className="conversation-more"
          title={error}
          onClick={() => {
            setError("");
            setAttempt(attempt + 1);
          }}
        >
          Retry attachment
        </button>
      )}
      <dialog
        ref={dialog}
        className="conversation-preview"
        onClose={onClose}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <div className="conversation-preview-header">
          <span>{attachment.name}</span>
          <button aria-label="Close attachment preview" onClick={() => dialog.current?.close()}>
            ×
          </button>
        </div>
        {!data ? (
          <div>
            <p role={error ? "alert" : "status"}>{error || "Loading attachment…"}</p>
            {error && (
              <button
                className="conversation-more"
                onClick={() => {
                  setError("");
                  setAttempt(attempt + 1);
                }}
              >
                Retry attachment
              </button>
            )}
          </div>
        ) : image ? (
          <img src={url} alt={attachment.name} />
        ) : text !== undefined ? (
          <pre>{text}</pre>
        ) : data?.mediaType === "application/pdf" ? (
          <iframe src={url} title={attachment.name} />
        ) : (
          <p>Preview is unavailable for this file type.</p>
        )}
        {!IS_DOM && url && (
          <a href={url} download={attachment.name}>
            Download file
          </a>
        )}
      </dialog>
    </div>
  );
}

function EditedFile({ edit, load }: { edit: ConversationEdit; load: AttachmentLoader }) {
  const openFile = useContext(OpenFile);
  const [hovered, setHovered] = useState(false);
  const [source, setSource] = useState<string>();
  useEffect(() => {
    if (!hovered || source !== undefined) return;
    let active = true;
    void load(edit.file.id).then(
      (data) => {
        if (active && data.mediaType.startsWith("text/")) setSource(decodeFile(data));
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [hovered, source, edit.file.id, load]);
  return (
    <div
      className="conversation-edit"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHovered(false);
      }}
    >
      <button
        className="conversation-edit-card"
        onClick={() => openFile(edit.file, edit)}
        aria-label={`View changes to ${edit.file.name}`}
      >
        <span className="conversation-edit-icon" aria-hidden="true">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3.5" y="2.5" width="17" height="19" rx="3.5" />
            <path d="M9 9h6m-3-3v6m-3 4h6" />
          </svg>
        </span>
        <span className="conversation-edit-label">
          <strong>Edited {edit.file.name}</strong>
          <small>
            <span className="edit-additions">+{edit.additions}</span>{" "}
            <span className="edit-deletions">−{edit.deletions}</span>
          </small>
        </span>
        <span className="conversation-edit-action">View changes</span>
      </button>
      {hovered && (
        <div className="conversation-edit-hover">
          <header>
            {edit.file.path ?? edit.file.name}{" "}
            <span>
              <span className="edit-additions">+{edit.additions}</span>{" "}
              <span className="edit-deletions">−{edit.deletions}</span>
            </span>
          </header>
          <DiffCode edit={edit} source={source} compact />
        </div>
      )}
    </div>
  );
}
