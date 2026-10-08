/** Providers whose desktop apps can display the destination of a web link. */
export function desktopLinkProvider(value: string): "linear" | "notion" | "slack" | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    if (url.hostname === "linear.app") return "linear";
    if (["notion.so", "www.notion.so", "app.notion.com", "notion.com", "www.notion.com"].includes(url.hostname))
      return "notion";
    if (/^[a-z0-9-]+\.slack\.com$/i.test(url.hostname)) return "slack";
    return undefined;
  } catch {
    return undefined;
  }
}
