const PACIFIC = "America/Los_Angeles";

function parts(value) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: PACIFIC,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(new Date(value))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }) => [type, part]),
  );
}

function pacificDayNumber(value) {
  const p = parts(value);
  return Math.floor(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86_400_000);
}

export function formatPacificUpdated(value, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const p = parts(date);
  const current = parts(now);
  const daysAgo = pacificDayNumber(now) - pacificDayNumber(date);
  const weekdayIndex = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(current.weekday);
  const daysSinceMonday = (weekdayIndex + 6) % 7;
  const day =
    daysAgo === 0
      ? "today"
      : daysAgo === 1
        ? "yesterday"
        : daysAgo >= 0 && daysAgo <= daysSinceMonday
          ? p.weekday
          : `${String(p.month).padStart(2, "0")}/${String(p.day).padStart(2, "0")}/${p.year}`;
  return `Updated ${day}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

export function formatPacificDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value));
}
