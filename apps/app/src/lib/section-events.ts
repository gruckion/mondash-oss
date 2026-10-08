/** Splits server-sent-events text into the complete events' data, and the unfinished rest to keep for later. */
export function takeEvents(buffer: string) {
  const end = buffer.lastIndexOf("\n\n");
  if (end < 0) return { data: [], rest: buffer };
  const data = buffer
    .slice(0, end)
    .split("\n\n")
    .flatMap((event) => {
      const lines = event.split("\n").filter((line) => line.startsWith("data: "));
      return lines.length ? [lines.map((line) => line.slice(6)).join("\n")] : [];
    });
  return { data, rest: buffer.slice(end + 2) };
}
