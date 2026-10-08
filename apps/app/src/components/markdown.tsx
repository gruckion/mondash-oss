import { type Components, Streamdown } from "streamdown";
import { Children, useMemo, useState, type ReactNode } from "react";
import type { ConversationAttachment } from "@mondash/shared/contract";
import { FileIcon, highlightCode } from "./source-code";
import { MarkdownTable, TableCopyContext } from "./markdown-table";
import { pullRequestIdentity } from "@mondash/shared/session-prs";
import { SessionPullRequestLink } from "./session-pull-requests";

function isGitHubLink(href?: string) {
  if (!href) return false;
  try {
    const { hostname, protocol } = new URL(href);
    return (
      (protocol === "https:" || protocol === "http:") && (hostname === "github.com" || hostname.endsWith(".github.com"))
    );
  } catch {
    return false;
  }
}

function CodeBlock({
  children,
  language,
  copyText,
}: {
  children: ReactNode;
  language: string;
  copyText?: (text: string) => Promise<void>;
}) {
  const text = Children.toArray(children)
    .filter((child) => typeof child === "string")
    .join("");
  const html = useMemo(() => highlightCode(text.slice(0, 300_000), language), [text, language]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="conversation-code-block">
      <pre className="conversation-code" data-language={language}>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      {copyText && (
        <button
          className="conversation-code-copy"
          aria-label={copied ? "Code copied" : "Copy code"}
          onClick={() => {
            void copyText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? (
            "✓"
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}

/** Shared DOM Markdown with readable local-file links and syntax-highlighted code. */
export function Markdown({
  text,
  openLink,
  attachments,
  copyText,
}: {
  text: string;
  openLink: (url: string) => Promise<void>;
  attachments?: readonly ConversationAttachment[];
  copyText?: (text: string) => Promise<void>;
}) {
  const components: Components = {
    table: MarkdownTable,
    a: ({ href, children }) => {
      if (href && pullRequestIdentity(href))
        return (
          <SessionPullRequestLink href={href} openLink={openLink}>
            {children}
          </SessionPullRequestLink>
        );
      const attachment = attachments?.find((file) => href === `#mondash-attachment-${file.id}`);
      return (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault();
            if (href) void openLink(href);
          }}
        >
          {attachment?.kind === "file" ? (
            <FileIcon name={attachment.name} />
          ) : (
            href?.startsWith("#mondash-attachment-") && (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                className="conversation-file-icon"
                aria-hidden="true"
              >
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8" cy="8" r="1.5" />
                <path d="m3 17 6-6 4 4 3-3 5 5" />
              </svg>
            )
          )}
          {isGitHubLink(href) && (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="conversation-file-icon conversation-github-icon"
              aria-hidden="true"
            >
              {/* GitHub: Primer Octicons (MIT), matching the app's SourceIcon. */}
              <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
            </svg>
          )}
          {children}
        </a>
      );
    },
    // Use the bundled file grammars; Streamdown's separate highlighter remains excluded from Metro.
    code: ({ children, className, ...props }) =>
      "data-block" in props ? (
        <CodeBlock language={className?.match(/language-([\w-]+)/)?.[1] ?? ""} copyText={copyText}>
          {children}
        </CodeBlock>
      ) : (
        <code className="conversation-inline-code">{children}</code>
      ),
  };
  return (
    <TableCopyContext value={copyText}>
      <Streamdown
        mode="static"
        controls={false}
        lineNumbers={false}
        linkSafety={{ enabled: false }}
        components={components}
      >
        {text}
      </Streamdown>
    </TableCopyContext>
  );
}
