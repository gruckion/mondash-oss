/** Open a Slack permalink in its thread, including when it points at the parent message. */
export function slackThreadUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.slack\.com$/i.test(url.hostname)) return value;
    const message = url.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/);
    if (!message) return value;
    const thread = url.searchParams.get("thread_ts");
    if (thread && !/^\d{10}\.\d{6}$/.test(thread)) return value;
    url.searchParams.set("thread_ts", thread || `${message[2]}.${message[3]}`);
    url.searchParams.set("cid", message[1]);
    return url.href;
  } catch {
    return value;
  }
}
