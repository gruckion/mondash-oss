import { createHash } from "node:crypto";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ConversationAttachment, SessionAttachment } from "@mondash/shared/contract";

const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_DATA = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/;
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".json": "text/plain",
  ".csv": "text/plain",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".js": "text/plain",
  ".py": "text/plain",
  ".log": "text/plain",
};
export type AttachmentSource = { attachment: ConversationAttachment; source: string; root?: string };
export const attachmentSource = (value: string, name?: string, line?: number): AttachmentSource => ({
  attachment: {
    id: createHash("sha256")
      .update(line ? `${value}:${line}` : value)
      .digest("hex"),
    name: name || (isAbsolute(value) ? basename(value) : "Attached image"),
    kind: IMAGE_DATA.test(value) || TYPES[extname(value).toLowerCase()]?.startsWith("image/") ? "image" : "file",
    ...(line ? { line } : {}),
    ...(isAbsolute(value) && !TYPES[extname(value).toLowerCase()]?.startsWith("image/")
      ? { path: basename(value) }
      : {}),
  },
  source: value,
});

/** Only explicit prompt metadata and Markdown file/image links become attachment sources. */
export function extractAttachments(text: string, images: readonly string[] = []) {
  const sources: AttachmentSource[] = [];
  const header = text.match(/^\s*# Files mentioned by the user:\s*\n([\s\S]*?)\n## My request:\s*\n/);
  if (header) {
    for (const match of header[1]!.matchAll(/^## (.+?): ((?:\/|[A-Za-z]:[\\/]).+)$/gm))
      sources.push(attachmentSource(match[2]!.trim(), match[1]!.trim()));
    text = text.slice(header[0].length);
  }
  // Image wrappers are split across text parts around input_image bytes.
  text = text.replace(/<image\b[^>]*>\s*<\/image>/g, "").replace(/<\/?image\b[^>]*>/g, "");
  const imageRefs = sources.filter((item) => item.attachment.kind === "image");
  images.forEach((image, index) => {
    if (!IMAGE_DATA.test(image)) return;
    const ref = imageRefs[index];
    if (ref) ref.source = image;
    else sources.push(attachmentSource(image, `Image ${index + 1}`));
  });
  text = text.replace(/(!?)\[([^\]]*)\]\(<?([^\n)]+?)>?\)/g, (whole, image: string, label: string, path: string) => {
    const location = path.match(/(?::|#L)(\d+)(?::\d+|(?:-L?\d+))?$/);
    const line = location && Number(location[1]) > 0 ? Number(location[1]) : undefined;
    let local = location ? path.slice(0, location.index) : path;
    if (local.startsWith("file:")) {
      try {
        local = fileURLToPath(local);
      } catch {
        return label || "Local file";
      }
    }
    if (!isAbsolute(local)) return whole;
    const attachment = attachmentSource(local, undefined, image ? undefined : line);
    // A link to an explicit image must retain its card and the transcript's durable image bytes.
    const existing = sources.find((item) => item.attachment.id === attachment.attachment.id);
    if (existing) {
      if (image && existing.attachment.inline) existing.attachment = { ...existing.attachment, inline: false };
    } else {
      if (!image) attachment.attachment = { ...attachment.attachment, inline: true };
      sources.push(attachment);
    }
    return image
      ? ""
      : `[${label || basename(local)}${line ? ` (line ${line})` : ""}](#mondash-attachment-${attachment.attachment.id})`;
  });
  return { text: text.trim(), sources: [...new Map(sources.map((item) => [item.attachment.id, item])).values()] };
}

/** Bounded regular-file reads, with no arbitrary path accepted from the app. */
export async function readAttachment(found: AttachmentSource): Promise<SessionAttachment> {
  const inline = found.source.match(IMAGE_DATA);
  if (inline) {
    const data = inline[2]!.replace(/\s/g, "");
    if (data.length > Math.ceil(MAX_BYTES / 3) * 4)
      throw new Error("This attachment is too large to preview (8 MB limit).");
    return { name: found.attachment.name, mediaType: inline[1]!, data };
  }
  if (!isAbsolute(found.source)) throw new Error("This attachment is unavailable.");
  let path = found.source;
  if (found.root) {
    path = await realpath(path);
    const within = relative(found.root, path);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new Error("This file is outside the session project.");
  }
  const file = await open(path, found.root ? constants.O_RDONLY | constants.O_NOFOLLOW : "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES)
      throw new Error("This attachment is too large to preview (8 MB limit).");
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_BYTES + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_BYTES) throw new Error("This attachment is too large to preview (8 MB limit).");
    return {
      name: found.attachment.name,
      mediaType: ["Dockerfile", "Makefile", "LICENSE"].includes(basename(found.source))
        ? "text/plain"
        : TYPES[extname(found.source).toLowerCase()] ||
          (/\.(?:[cm]?[jt]sx?|rb|rs|go|java|kt|swift|c|h|cpp|cs|php|sh|zsh|bash|ya?ml|toml|xml|html?|css|scss|sql|graphql|vue|svelte)$/i.test(
            found.source,
          )
            ? "text/plain"
            : "application/octet-stream"),
      data: buffer.subarray(0, bytesRead).toString("base64"),
    };
  } finally {
    await file.close();
  }
}
