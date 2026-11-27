import { dayKey, type CalendarEntry } from "./todo-calendar";
import { fingerprint } from "./feed-cache";

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// RFC 5545 TEXT uses a backslash for punctuation and newlines. Other control characters
// (except tab) cannot appear in a content line.
function summary(title: string): string {
  return title.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\").replace(/\r\n|[\r\n]/g, "\\n").replace(/[,;]/g, "\\$&");
}

// Each physical line gets 75 octets, including a continuation's leading space.
function fold(line: string): string {
  const encoder = new TextEncoder();
  let result = "";
  let length = 0;
  for (const character of line) {
    const bytes = encoder.encode(character).length;
    if (length + bytes > 75) {
      result += "\r\n ";
      length = 1;
    }
    result += character;
    length += bytes;
  }
  return result;
}

export function deadlineCalendar(entries: readonly CalendarEntry[], now: number): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Persona//To-do deadlines//EN"];
  const stamp = utcStamp(now);
  for (const entry of entries) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${fingerprint(entry.id)}@todos.persona.invalid`,
      `DTSTAMP:${stamp}`,
      entry.allDay ? `DTSTART;VALUE=DATE:${dayKey(entry.start).replaceAll("-", "")}` : `DTSTART:${utcStamp(entry.start)}`,
      fold(`SUMMARY:${summary(entry.title)}`),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  return [...lines, "END:VCALENDAR", ""].join("\r\n");
}

export function downloadDeadlines(entries: readonly CalendarEntry[], firstDay: number): void {
  const blob = new Blob([deadlineCalendar(entries, Date.now())], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = `deadlines-${dayKey(firstDay)}.ics`;
  link.href = url;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
