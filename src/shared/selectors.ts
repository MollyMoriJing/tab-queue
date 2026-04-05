import { BUCKET_LABELS } from "./constants";
import { buildNudgeMessage, isDueToday, isOverdue, isSameDay, startOfToday } from "./date";
import type { AppState, BucketId, CompletedItem, QueueItem, QueueSummary } from "./types";

export function sortBucketItems(items: QueueItem[]): QueueItem[] {
  return [...items].sort((left, right) => left.order - right.order);
}

export function groupItemsByBucket(items: QueueItem[]): Record<BucketId, QueueItem[]> {
  return {
    today: sortBucketItems(items.filter((item) => item.bucket === "today")),
    week: sortBucketItems(items.filter((item) => item.bucket === "week")),
    later: sortBucketItems(items.filter((item) => item.bucket === "later")),
    waiting: sortBucketItems(items.filter((item) => item.bucket === "waiting"))
  };
}

export function getQueueSummary(items: QueueItem[]): QueueSummary {
  return items.reduce<QueueSummary>(
    (summary, item) => {
      if (isDueToday(item.dueAt)) {
        summary.dueToday += 1;
      }

      if (isOverdue(item.dueAt)) {
        summary.overdue += 1;
      }

      if (item.status === "in_progress") {
        summary.inProgress += 1;
      }

      summary.total += 1;
      return summary;
    },
    { total: 0, dueToday: 0, overdue: 0, inProgress: 0 }
  );
}

export function getHabitCue(state: AppState): string {
  const summary = getQueueSummary(state.items);
  return buildNudgeMessage(summary.total, summary.dueToday, summary.overdue);
}

export function getReviewHeadline(completedItems: CompletedItem[]): string {
  if (completedItems.length === 0) {
    return "Nothing completed yet. Done will keep a light private record here.";
  }

  const completedToday = completedItems.filter((item) => isSameDay(item.completedAt, new Date().toISOString())).length;
  if (completedToday > 0) {
    return `${completedToday} tab${completedToday === 1 ? "" : "s"} completed today. Small wins keep the queue honest.`;
  }

  const recent = completedItems.filter(
    (item) => new Date(item.completedAt).getTime() >= startOfToday().getTime() - 6 * 24 * 60 * 60 * 1000
  ).length;
  return `${recent} completions in the last 7 days. Review patterns, not trophies.`;
}

export function getTopBuckets(completedItems: CompletedItem[]): Array<{ bucket: BucketId; count: number }> {
  const counts = completedItems.reduce<Record<BucketId, number>>(
    (result, item) => {
      result[item.bucket] += 1;
      return result;
    },
    { today: 0, week: 0, later: 0, waiting: 0 }
  );

  return (Object.keys(counts) as BucketId[])
    .map((bucket) => ({ bucket, count: counts[bucket] }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, 3);
}

export function bucketOptions(): Array<{ value: BucketId; label: string }> {
  return Object.entries(BUCKET_LABELS).map(([value, label]) => ({
    value: value as BucketId,
    label
  }));
}

export function domainForUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
