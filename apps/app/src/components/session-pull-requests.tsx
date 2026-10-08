import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SessionPullRequest } from "@mondash/shared/contract";
import { pullRequestIdentity } from "@mondash/shared/session-prs";
import { prStateSvg } from "@mondash/shared/pr-icons";

export const SessionPRContext = createContext<{ prs: readonly SessionPullRequest[]; dark: boolean }>({
  prs: [],
  dark: false,
});

function PRIcon({ state }: { state?: SessionPullRequest["state"] }) {
  return (
    <span
      className="conversation-pr-icon"
      aria-hidden="true"
      dangerouslySetInnerHTML={{
        __html: prStateSvg(state ?? "DRAFT", { secondary: "#999999", unreviewed: "#666666" }),
      }}
    />
  );
}

function Changes({ pr }: { pr: SessionPullRequest }) {
  return (
    pr.changes && (
      <span className="conversation-pr-changes">
        <span>+{pr.changes.additions.toLocaleString()}</span> <span>−{pr.changes.deletions.toLocaleString()}</span>
      </span>
    )
  );
}

function Preview({ pr }: { pr: SessionPullRequest }) {
  const state =
    pr.state === "DRAFT"
      ? "Draft"
      : pr.state === "MERGED"
        ? "Merged"
        : pr.state === "CLOSED"
          ? "Closed"
          : pr.state === "OPEN"
            ? "Open"
            : "Unavailable";
  return (
    <>
      <div className="conversation-pr-preview-top">
        <span className={`conversation-pr-state ${pr.state?.toLowerCase() ?? "unknown"}`}>
          <PRIcon state={pr.state} />
          {state}
        </span>
        <span>
          {pr.repo} #{pr.number}
        </span>
        {pr.updatedAt && (
          <time dateTime={pr.updatedAt}>
            {new Date(pr.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </time>
        )}
      </div>
      <strong>{pr.title ?? "Pull request details unavailable"}</strong>
      <div className="conversation-pr-preview-bottom">
        <span className="conversation-pr-author">
          {pr.author?.avatar && <img src={pr.author.avatar} alt="" />}
          {pr.author?.name}
        </span>
        <Changes pr={pr} />
        {pr.changes && <span>{pr.changes.files} files</span>}
      </div>
    </>
  );
}

/** Rich references preserve the original URL (including comments and file anchors) when clicked. */
export function SessionPullRequestLink({
  href,
  openLink,
  children,
}: {
  href: string;
  openLink: (url: string) => Promise<void>;
  children?: ReactNode;
}) {
  const { prs, dark } = useContext(SessionPRContext);
  const identity = pullRequestIdentity(href);
  const pr = identity && prs.find((pr) => pullRequestIdentity(pr.url)?.key === identity.key);
  const tooltipId = useId();
  const anchor = useRef<HTMLAnchorElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const show = () => {
    const box = anchor.current?.getBoundingClientRect();
    if (!box || !pr) return;
    setPosition({
      left: Math.max(12, Math.min(box.left, window.innerWidth - 392)),
      top: box.bottom + 148 < window.innerHeight ? box.bottom + 8 : Math.max(12, box.top - 148),
    });
  };
  useEffect(() => {
    if (!position) return;
    const dismiss = () => setPosition(undefined);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    document.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("keydown", key);
    };
  }, [position]);
  if (!identity) return null;
  return (
    <>
      <a
        ref={anchor}
        href={href}
        aria-describedby={position ? tooltipId : undefined}
        className="conversation-pr-link"
        onMouseEnter={show}
        onMouseLeave={() => setPosition(undefined)}
        onFocus={show}
        onBlur={() => setPosition(undefined)}
        onClick={(event) => {
          event.preventDefault();
          setPosition(undefined);
          void openLink(href);
        }}
      >
        <PRIcon state={pr?.state} />
        <span>
          {pr?.title ? `${pr.repo}#${pr.number} · ${pr.title}` : (children ?? `${identity.repo}#${identity.number}`)}
        </span>
      </a>
      {position &&
        pr &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            className={`conversation-pr-preview${dark ? " dark" : ""}`}
            style={position}
          >
            <Preview pr={pr} />
          </div>,
          document.body,
        )}
    </>
  );
}

function CI({ pr, openLink }: { pr: SessionPullRequest; openLink: (url: string) => Promise<void> }) {
  const { dark } = useContext(SessionPRContext);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  useEffect(() => {
    if (!position) return;
    const dismiss = () => setPosition(undefined);
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !button.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
        dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [position]);
  const checks = pr.checksSummary;
  const tone =
    pr.checks === "FAILURE" || pr.checks === "CANCELLED"
      ? "failed"
      : pr.checks === "PENDING"
        ? "pending"
        : pr.checks === "SUCCESS"
          ? "passed"
          : "unknown";
  return (
    <div className="conversation-pr-ci">
      <button
        ref={button}
        aria-expanded={!!position}
        aria-label={`CI for ${pr.repo}#${pr.number}: ${tone}`}
        onClick={() => {
          if (position) return setPosition(undefined);
          const rect = button.current?.getBoundingClientRect();
          if (rect)
            setPosition({
              left: Math.max(12, Math.min(rect.right - 200, window.innerWidth - 212)),
              top: Math.max(12, rect.top - 214),
            });
        }}
      >
        <span className={`conversation-pr-ci-dot ${tone}`} />
        CI <span aria-hidden="true">⌄</span>
      </button>
      {position &&
        createPortal(
          <div
            ref={panel}
            role="region"
            aria-label={`Checks for ${pr.repo}#${pr.number}`}
            className={`conversation-pr-preview conversation-pr-ci-panel${dark ? " dark" : ""}`}
            style={position}
          >
            <strong>Checks</strong>
            {checks ? (
              <>
                <span>{checks.passed} passed</span>
                <span>{checks.failed} failed</span>
                <span>{checks.pending} pending</span>
                <span>
                  {checks.skipped} skipped{checks.cancelled ? ` · ${checks.cancelled} cancelled` : ""}
                </span>
              </>
            ) : (
              <span>No checks reported</span>
            )}
            <button onClick={() => void openLink(`${pr.url}/checks`)}>View on GitHub ↗</button>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function SessionPullRequests({
  prs,
  truncated,
  error,
  retry,
  openLink,
}: {
  prs: readonly SessionPullRequest[];
  truncated?: boolean;
  error?: string;
  retry?: () => Promise<void>;
  openLink: (url: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!prs.length && !error) return null;
  const visible = expanded ? prs : prs.slice(0, 2);
  return (
    <aside className="conversation-prs" aria-label="Associated pull requests">
      {error && (
        <div role="status" className="conversation-pr-error">
          {error} {retry && <button onClick={() => void retry()}>Retry</button>}
        </div>
      )}
      <div className="conversation-prs-list">
        {visible.map((pr) => (
          <div key={pr.url} className={`conversation-pr-row ${pr.state?.toLowerCase() ?? "unknown"}`}>
            <button
              className="conversation-pr-row-link"
              title={pr.title ?? pr.url}
              onClick={() => void openLink(pr.url)}
            >
              <PRIcon state={pr.state} />
              <span>#{pr.number}</span>
              <span>{pr.repo.split("/").at(-1)}</span>
              <code>{pr.branch ?? pr.title ?? "Details unavailable"}</code>
            </button>
            {pr.state === "MERGED" || pr.state === "CLOSED" ? (
              <span className="conversation-pr-row-state">{pr.state === "MERGED" ? "Merged" : "Closed"}</span>
            ) : (
              <>
                <Changes pr={pr} />
                {pr.state === "DRAFT" && <span className="conversation-pr-row-state">Draft</span>}
                {pr.state && <CI pr={pr} openLink={openLink} />}
              </>
            )}
          </div>
        ))}
      </div>
      {prs.length > 2 && (
        <button className="conversation-pr-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `Show ${prs.length - 2} more`}
        </button>
      )}
      {truncated && <small>Showing the first 30 associated pull requests.</small>}
    </aside>
  );
}
