import type { CalendarEvent } from "./contract";

export function calendarEventPresentation(event: CalendarEvent, now = new Date()) {
  const start = new Date(event.startsAt);
  const end = event.endsAt ? new Date(event.endsAt) : undefined;
  const day =
    start.toDateString() === now.toDateString()
      ? "Today"
      : start.toLocaleDateString("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "short",
          ...(start.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
        });
  const time = (date: Date) => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const minutes = Math.ceil((start.getTime() - now.getTime()) / 60_000);
  return {
    when: `${day}, ${time(start)}${end ? ` – ${end.toDateString() !== start.toDateString() ? `${end.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ` : ""}${time(end)}` : ""}`,
    status:
      minutes > 0
        ? minutes < 60
          ? `Starts in ${minutes} min`
          : "Upcoming"
        : end
          ? now.getTime() < end.getTime()
            ? "In progress"
            : "Ended"
          : "Started",
  };
}
