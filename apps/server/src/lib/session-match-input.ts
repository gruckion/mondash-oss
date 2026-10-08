import type { AgentSession } from "./sessions";
import type { WorkItem } from "./session-match";
import { cleanEvidence, type EvidenceMessage } from "./session-evidence";

const STOP = new Set(
  "the a an and or to of in on for from with this that it its is are as all use add fix pr chore type open".split(" "),
);

/** The benchmarked small topic digest and two request/result exchanges, bounded independently of transcript size. */
export function matchInput(session: AgentSession, item: WorkItem, messages: readonly EvidenceMessage[]) {
  const needles = item.refs
    .flatMap((ref) => {
      if (ref.startsWith("ticket:")) return [ref.slice(7)];
      if (ref.startsWith("pr:")) {
        const [repo, number] = ref.slice(3).split("#");
        return [`github.com/${repo}/pull/${number}`, `${repo.split("/").at(-1)}#${number}`, `#${number}`];
      }
      if (ref.startsWith("notion:")) {
        const id = ref.slice(7).replaceAll("-", "");
        return [id, id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")];
      }
      if (ref.startsWith("slack:")) {
        const [channel, timestamp] = ref.slice(6).split("/");
        return [`archives/${channel}/p${timestamp.replace(".", "")}`, `thread_ts=${timestamp}`];
      }
      return [];
    })
    .map((needle) => needle.toLowerCase());
  const terms = [
    ...new Set(
      item.title
        .toLowerCase()
        .replace(/\b[a-z]{2,6}-\d+\b/g, " ")
        .match(/[a-z]{3,}/g) ?? [],
    ),
  ].filter((term) => !STOP.has(term));
  const relevance = (text: string) => {
    const lower = text.toLowerCase();
    return needles.filter((n) => lower.includes(n)).length * 8 + terms.filter((term) => lower.includes(term)).length;
  };
  const window = (text: string, cap: number) => {
    if (text.length <= cap) return text;
    const hits = needles.map((n) => text.toLowerCase().indexOf(n)).filter((at) => at >= 0);
    const at = hits.length ? Math.max(0, Math.min(...hits) - 100) : 0;
    return `${at ? "…" : ""}${text.slice(at, at + cap)}${at + cap < text.length ? "…" : ""}`;
  };
  const target = {
    key: item.key.slice(0, 500),
    kind: item.kind,
    title: cleanEvidence(item.title).slice(0, 500),
    references: item.refs.slice(0, 16).map((ref) => ref.slice(0, 240)),
  };
  const first = messages.find((message) => message.role === "user")?.text ?? cleanEvidence(session.firstPrompt);
  const tiny = {
    target,
    session: {
      session_title: cleanEvidence(session.title).slice(0, 300),
      first_request: first.slice(0, 300),
      last_request: cleanEvidence(session.lastPrompt).slice(0, 240),
      latest_response: cleanEvidence(session.preview ?? "").slice(0, 400),
    },
  };
  const turns: { user: string; assistant: string; score: number; index: number }[] = [];
  let current: (typeof turns)[number] | undefined;
  for (const message of messages) {
    if (message.role === "context") {
      current = undefined;
      continue;
    }
    if (message.role === "user") {
      current = { user: message.text, assistant: "", score: relevance(message.text), index: turns.length };
      turns.push(current);
    } else if (current && (!current.assistant || relevance(message.text) > relevance(current.assistant))) {
      current.assistant = message.text;
      current.score = Math.max(relevance(current.user), relevance(message.text));
    }
  }
  const selected = turns
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const paired = {
    target,
    session_title: tiny.session.session_title,
    first_request: first.slice(0, 220),
    work_exchanges: selected.map((turn) => ({ user: window(turn.user, 320), assistant: window(turn.assistant, 600) })),
  };
  return { tiny, paired };
}
