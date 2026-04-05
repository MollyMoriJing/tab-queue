import type { AppSettings, BucketId } from "./types";

export const DEFAULT_SETTINGS: AppSettings = {
  storageMode: "local",
  archiveSyncMode: "local_only",
  maxActiveItems: 150,
  maxArchiveItems: 200
};

export const BUCKET_LABELS: Record<BucketId, string> = {
  today: "Today",
  week: "This Week",
  later: "Later",
  waiting: "Waiting"
};

export const APP_STATE_KEY = "tabQueueState";
export const ARCHIVE_STATE_KEY = "tabQueueArchiveState";
export const STORAGE_MODE_KEY = "tabQueueStorageMode";
export const ARCHIVE_SYNC_MODE_KEY = "tabQueueArchiveSyncMode";
export const SETTINGS_KEY = "tabQueueSettings";
export const ITEM_LIMIT = 150;
export const ARCHIVE_LIMIT = 200;
export const SYNC_WARNING_BYTES = 90_000;
export const ALARM_PREFIX = "queue-item:";

export const PANEL_WIDTH_HINT = 420;
