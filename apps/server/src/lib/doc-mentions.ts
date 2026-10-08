// No "@/" imports, so tests can import it.

const TICKETS = /\b([A-Z]{2,5}-\d{2,6})\b/g;

/**
 * Each ticket ID a Notion page's own words name, with the text around its first mention. Only the page content
 * counts: the properties before it are escaped JSON (people, status, URL) that tell Jev nothing about the tie.
 */
export function docMentions(page: string, context = 400): Map<string, string> {
  const end = page.indexOf("</properties>");
  const content = (end === -1 ? page : page.slice(end + "</properties>".length))
    .replace(/<iconMetadata>[\s\S]*?<\/iconMetadata>/g, " ")
    // Page markup (<content>, <empty-block/>) is not words.
    .replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>/gi, " ");
  const mentions = new Map<string, string>();
  for (const m of content.matchAll(TICKETS)) {
    const id = m[0].toUpperCase();
    // The first mention usually explains the tie; later ones repeat it.
    if (!mentions.has(id))
      mentions.set(
        id,
        content
          .slice(Math.max(0, m.index - context), m.index + context)
          .replace(/\s+/g, " ")
          .trim(),
      );
  }
  return mentions;
}
