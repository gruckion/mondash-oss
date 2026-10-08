"use dom";

import "./conversation.css";
import { useLayoutEffect } from "react";
import { IS_DOM, type DOMProps } from "expo/dom";
import type { DebriefItem, DebriefReport } from "@mondash/shared/contract";
import { Markdown } from "./markdown";

const category = {
  action: "Needs you",
  context: "Worth knowing",
  uncertain: "Check this",
  resolved: "Resolved",
  noise: "Noise",
};
const urgency = { today: "Today", soon: "This week", later: "Background" };
const date = (value: string) => new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function Finding({
  item,
  rank,
  openLink,
}: {
  item: DebriefItem;
  rank?: number;
  openLink: (url: string) => Promise<void>;
}) {
  return (
    <section className="debrief-finding">
      <div className="conversation-meta">
        <span className={item.category === "action" ? "debrief-action" : undefined}>
          {category[item.category]} · {urgency[item.urgency]}
        </span>{" "}
        ·{" "}
        {item.confidence === 0 && item.category === "uncertain"
          ? "Jev unavailable"
          : `Jev ${Math.round(item.confidence * 100)}%`}
      </div>
      <h2>
        {rank ? `${rank}. ` : ""}
        {item.title}
      </h2>
      <Markdown text={item.detail} openLink={openLink} />
      {item.category !== "noise" && item.category !== "resolved" && (
        <div className="debrief-next">
          <div className="conversation-meta">Next step</div>
          <Markdown text={item.nextStep} openLink={openLink} />
        </div>
      )}
      <div className="debrief-sources">
        {item.sources.map((source) => (
          <a
            key={source.url}
            href={source.url}
            onClick={(event) => {
              event.preventDefault();
              void openLink(source.url);
            }}
          >
            {source.title} ↗
          </a>
        ))}
      </div>
    </section>
  );
}

/** One DOM surface per report, including collapsed sections, instead of a web view per paragraph. */
export default function DebriefContent({
  report,
  dark,
  openLink,
  width,
}: {
  report: DebriefReport;
  width: number;
  dark: boolean;
  openLink: (url: string) => Promise<void>;
  dom?: DOMProps;
}) {
  useLayoutEffect(() => {
    if (!IS_DOM) return;
    document.body.style.margin = "0";
    document.documentElement.style.background = dark ? "#0a0a0a" : "#ffffff";
  }, [dark]);
  useLayoutEffect(() => {
    if (!IS_DOM) return;
    const meta = document.querySelector('meta[name="viewport"]');
    const content = `width=${Math.round(width)}, initial-scale=1`;
    if (meta) meta.setAttribute("content", content);
    else document.head.insertAdjacentHTML("beforeend", `<meta name="viewport" content="${content}">`);
  }, [width]);
  const active = report.items.filter((i) => i.category === "action" || i.category === "context");
  const uncertain = report.items.filter((i) => i.category === "uncertain");
  const hidden = report.items.filter((i) => i.category === "resolved" || i.category === "noise");
  return (
    <article className={`conversation debrief-content${dark ? " dark" : ""}`}>
      <div className="debrief-action">
        {date(report.since)} – {date(report.until)} · {active.length} to review
      </div>
      <Markdown text={report.summary} openLink={openLink} />
      <div className="conversation-meta">
        {report.scannedMessages} messages · {report.scannedThreads} conversations ·{" "}
        {hidden.reduce((n, i) => n + i.sources.length, 0)} conversations filtered out
        <br />
        Prepared {new Date(report.generatedAt).toLocaleString("en-GB")} · Saved snapshot
      </div>
      {report.warnings.map((warning) => (
        <p key={warning} className="conversation-meta">
          {warning}
        </p>
      ))}
      <div>
        {active.map((item, index) => (
          <Finding key={item.id} item={item} rank={index + 1} openLink={openLink} />
        ))}
      </div>
      {!!uncertain.length && (
        <details>
          <summary>Review {uncertain.length} uncertain topics</summary>
          {uncertain.map((item) => (
            <Finding key={item.id} item={item} openLink={openLink} />
          ))}
        </details>
      )}
      {!!hidden.length && (
        <details>
          <summary>{hidden.length} resolved / noise items</summary>
          {hidden.map((item) => (
            <Finding key={item.id} item={item} openLink={openLink} />
          ))}
        </details>
      )}
    </article>
  );
}
