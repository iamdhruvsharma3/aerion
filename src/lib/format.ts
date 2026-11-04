// Explicit units avoid ICU compact-currency differences between Node and browsers.
export const money = (value: number | null) => {
  if (value === null) return "Price on request";
  if (value >= 1_000_000) return `$${Number((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1_000) return `$${Number((value / 1_000).toFixed(2))}K`;
  return `$${Number(value.toFixed(2))}`;
};
export const number = (value: number | null) =>
  value === null ? "Not supplied" : new Intl.NumberFormat("en-US").format(value);
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dateLabel = (value: string | null) => {
  if (value === null) return "To be confirmed";
  const [year, month, day] = value.split("-").map(Number);
  return `${day} ${months[month - 1]} ${year}`;
};
export const initials = (name: string) =>
  name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("");

export function downloadText(filename: string, contents: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// This founder workspace uses the user's India timezone consistently on server and browser.
export const workspaceTimeZone = "Asia/Kolkata";
export function calendarDate(value = new Date(), timeZone = workspaceTimeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function dateTimeLabel(value: string | Date) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: workspaceTimeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
