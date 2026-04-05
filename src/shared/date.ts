import type { BucketId, DueHint, ReminderPreset } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export function nowIso(): string {
  return new Date().toISOString();
}

export function startOfToday(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function endOfToday(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

export function deriveBucketFromDueAt(dueAt?: string): BucketId {
  if (!dueAt) {
    return "later";
  }

  const dueDate = new Date(dueAt);
  const todayStart = startOfToday();
  const todayEnd = endOfToday();
  const weekEnd = new Date(todayStart.getTime() + 7 * DAY_MS);

  if (dueDate <= todayEnd) {
    return "today";
  }

  if (dueDate < weekEnd) {
    return "week";
  }

  return "later";
}

export function buildDueAtFromPreset(
  preset: ReminderPreset,
  customDueAt?: string
): string | undefined {
  const now = new Date();

  if (preset === "none") {
    return undefined;
  }

  if (preset === "custom") {
    return customDueAt ? new Date(customDueAt).toISOString() : undefined;
  }

  if (preset === "tonight") {
    const tonight = new Date(now);
    tonight.setHours(20, 0, 0, 0);
    if (tonight <= now) {
      tonight.setDate(tonight.getDate() + 1);
    }
    return tonight.toISOString();
  }

  if (preset === "tomorrow") {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return tomorrow.toISOString();
  }

  const weekend = new Date(now);
  const day = weekend.getDay();
  const distanceToSaturday = day === 6 ? 0 : (6 - day + 7) % 7;
  weekend.setDate(weekend.getDate() + distanceToSaturday);
  weekend.setHours(10, 0, 0, 0);
  return weekend.toISOString();
}

export function labelForReminderPreset(preset: ReminderPreset, dueAt?: string): string {
  if (preset === "none") {
    return "No reminder";
  }

  if (preset === "custom") {
    return dueAt ? `By ${formatDueLabel(dueAt)}` : "Custom time";
  }

  if (preset === "tonight") {
    return "Tonight";
  }

  if (preset === "tomorrow") {
    return "Tomorrow";
  }

  return "This weekend";
}

export function buildDueHint(preset: ReminderPreset, customDueAt?: string): DueHint | undefined {
  if (preset === "none") {
    return undefined;
  }

  const dueAt = buildDueAtFromPreset(preset, customDueAt);

  return {
    preset,
    dueAt,
    label: labelForReminderPreset(preset, dueAt)
  };
}

export function formatDueLabel(dueAt?: string): string {
  if (!dueAt) {
    return "No reminder";
  }

  const due = new Date(dueAt);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(due);
}

export function isOverdue(dueAt?: string): boolean {
  return !!dueAt && new Date(dueAt).getTime() < Date.now();
}

export function isDueToday(dueAt?: string): boolean {
  if (!dueAt) {
    return false;
  }

  const due = new Date(dueAt).getTime();
  return due >= startOfToday().getTime() && due <= endOfToday().getTime();
}

export function toDateTimeLocalValue(value?: string): string {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

export function buildNudgeMessage(total: number, dueToday: number, overdue: number): string {
  if (overdue > 0) {
    return `You have ${overdue} overdue tab${overdue === 1 ? "" : "s"}. Clear one now to keep the queue light.`;
  }

  if (dueToday > 0) {
    return `${dueToday} tab${dueToday === 1 ? "" : "s"} are due today. Small check-ins keep the pile from growing.`;
  }

  if (total === 0) {
    return "Your queue is clear. Capture tabs only when they truly need a return visit.";
  }

  if (total > 12) {
    return "Your queue is getting crowded. Drag one stale item into Done or delete it.";
  }

  return "Keep the list short, revisit intentionally, and close tabs with confidence.";
}

export function isSameDay(left: string, right: string): boolean {
  const leftDate = new Date(left);
  const rightDate = new Date(right);

  return (
    leftDate.getFullYear() === rightDate.getFullYear() &&
    leftDate.getMonth() === rightDate.getMonth() &&
    leftDate.getDate() === rightDate.getDate()
  );
}
