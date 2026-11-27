// Dates are constructed in the browser's time zone. Run in both a DST zone and a zone east of UTC.
import { describe, expect, it } from "vitest";
import { calendarEntries, calendarRange } from "./todo-calendar";
import { deadlineCalendar } from "./todo-calendar-export";
import type { Todo } from "./todos";

const stamp = Date.UTC(2026, 10, 8, 12, 34, 56);
const todo = (id: string, title: string, fields: Partial<Todo>): Todo => ({ id, title, agents: [], ...fields }) as Todo;
const items = [
  todo("private-id-1", "Bring flowers", { due_date: "2026-11-01", notes: "private notes", origin: "private-session", manager: "private-device", plan_id: "private-plan" }),
  todo("private-id-2", "First Sunday shift", { due_at: "2026-11-01T01:30:00-04:00" }),
  todo("private-id-3", "Second Sunday shift", { due_at: "2026-11-01T01:30:00-05:00", done_at: "2026-11-01T12:00:00Z" }),
  todo("private-id-4", "Next month", { due_date: "2026-12-10" }),
  todo("private-id-5", "Unscheduled", {}),
];
function visible(todos = items, showDone = true) {
  const [from, to] = calendarRange("week", new Date(2026, 10, 1).getTime(), 0);
  return calendarEntries(todos, { from, to, showDone, now: stamp });
}
const unfold = (file: string) => file.replaceAll("\r\n ", "");

describe("deadline calendar download", () => {
  it("keeps a local date and both instants of the repeated hour, leaving availability free", () => {
    const file = deadlineCalendar(visible(), stamp);
    expect(file).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(file).toContain("VERSION:2.0\r\n");
    expect(file).toContain("PRODID:");
    expect(file).toMatch(/END:VCALENDAR\r\n$/);
    expect(file.match(/BEGIN:VEVENT\r\n/g)).toHaveLength(3);
    expect(file.match(/END:VEVENT\r\n/g)).toHaveLength(3);
    expect(file.match(/TRANSP:TRANSPARENT\r\n/g)).toHaveLength(3);
    expect(file.match(/DTSTAMP:20261108T123456Z\r\n/g)).toHaveLength(3);
    expect(file).toContain("DTSTART;VALUE=DATE:20261101\r\n");
    expect(file).toContain("DTSTART:20261101T053000Z\r\n");
    expect(file).toContain("DTSTART:20261101T063000Z\r\n");
    expect(file).not.toMatch(/private-|private notes|DTEND|DURATION|Next month|Unscheduled/);
    expect(deadlineCalendar(visible(items, false), stamp)).not.toContain("Second Sunday shift");
  });

  it("keeps distinct opaque UIDs after edits, navigation and another download", () => {
    const entries = visible();
    const ids = (file: string) => [...unfold(file).matchAll(/^UID:(.+)\r$/gm)].map(m => m[1]);
    const first = ids(deadlineCalendar(entries, stamp));
    const edited = { ...entries[1], title: "Rescheduled", start: entries[1].start + 3600000 };
    expect(new Set(first).size).toBe(entries.length);
    expect(ids(deadlineCalendar([edited], stamp + 1000))).toEqual([first[1]]);
  });

  it("escapes TEXT and folds at 75 UTF-8 bytes without splitting a character", () => {
    const words = "予定📅周末".repeat(13);
    const title = words + ", tea; milk\\coffee\r\nLOCATION:home\nend\rfinish";
    const file = deadlineCalendar([{ ...visible()[0], title }], stamp);
    for (const line of file.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(file).toContain("\r\n ");
    expect(unfold(file)).toContain("SUMMARY:" + words + "\\, tea\\; milk\\\\coffee\\nLOCATION:home\\nend\\nfinish\r\n");
    expect(file.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  });
});
