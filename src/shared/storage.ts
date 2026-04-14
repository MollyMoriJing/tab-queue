import {
  APP_STATE_KEY,
  ARCHIVE_LIMIT,
  ARCHIVE_STATE_KEY,
  ARCHIVE_SYNC_MODE_KEY,
  DEFAULT_SETTINGS,
  ITEM_LIMIT,
  SETTINGS_KEY,
  STORAGE_MODE_KEY,
  SYNC_WARNING_BYTES
} from "./constants";
import { isDueToday, isSameDay, nowIso } from "./date";
import type {
  AppSettings,
  AppState,
  ArchiveSyncMode,
  BucketId,
  CompletedItem,
  CompletionStats,
  QueueItem,
  StorageMode
} from "./types";

type StoredActiveState = {
  version: number;
  items: QueueItem[];
  updatedAt: string;
  settings?: Partial<AppSettings>;
};

type StoredArchiveState = {
  version: number;
  completedItems: CompletedItem[];
  updatedAt: string;
};

type StoredSettings = {
  version: number;
  settings: Partial<AppSettings>;
  updatedAt: string;
};

function estimateSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function getArea(storageMode: StorageMode): chrome.storage.StorageArea {
  return storageMode === "sync" ? chrome.storage.sync : chrome.storage.local;
}

function getArchiveArea(settings: AppSettings): chrome.storage.StorageArea {
  if (settings.archiveSyncMode === "local_only") {
    return chrome.storage.local;
  }

  if (settings.archiveSyncMode === "sync_enabled") {
    return chrome.storage.sync;
  }

  return getArea(settings.storageMode);
}

function normalizeItems(items: QueueItem[]): QueueItem[] {
  const grouped = items.reduce<Record<BucketId, QueueItem[]>>(
    (result, item) => {
      result[item.bucket].push(item);
      return result;
    },
    { today: [], week: [], later: [], waiting: [] }
  );

  const normalized = (Object.keys(grouped) as BucketId[]).flatMap((bucket) =>
    grouped[bucket]
      .sort((left, right) => left.order - right.order)
      .map((item, index) => ({
        ...item,
        order: index
      }))
  );

  return normalized.slice(0, ITEM_LIMIT);
}

function normalizeArchiveItems(items: CompletedItem[]): CompletedItem[] {
  return [...items]
    .sort((left, right) => new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime())
    .slice(0, ARCHIVE_LIMIT);
}

function computeCurrentStreak(completedItems: CompletedItem[]): number {
  if (completedItems.length === 0) {
    return 0;
  }

  const days = Array.from(
    new Set(
      completedItems.map((item) => {
        const date = new Date(item.completedAt);
        return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
      })
    )
  ).sort((left, right) => new Date(right).getTime() - new Date(left).getTime());

  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  for (const day of days) {
    if (!isSameDay(day, cursor.toISOString())) {
      if (streak === 0) {
        return 0;
      }
      break;
    }

    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}

function computeTopBucket(completedItems: CompletedItem[]): BucketId | undefined {
  const counts = completedItems.reduce<Record<BucketId, number>>(
    (result, item) => {
      result[item.bucket] += 1;
      return result;
    },
    { today: 0, week: 0, later: 0, waiting: 0 }
  );

  return (Object.keys(counts) as BucketId[]).sort((left, right) => counts[right] - counts[left])[0];
}

export function computeCompletionStats(completedItems: CompletedItem[]): CompletionStats {
  const normalized = normalizeArchiveItems(completedItems);
  return {
    completedCount: normalized.length,
    completedToday: normalized.filter((item) => isDueToday(item.completedAt)).length,
    currentStreak: computeCurrentStreak(normalized),
    topBucket: normalized.length > 0 ? computeTopBucket(normalized) : undefined,
    lastCompletedAt: normalized[0]?.completedAt
  };
}

function sanitizeSettings(settings?: Partial<AppSettings>): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    maxActiveItems: ITEM_LIMIT,
    maxArchiveItems: ARCHIVE_LIMIT
  };
}

function parseStoredSettings(payload: unknown): StoredSettings | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const candidate = payload as Partial<StoredSettings>;
  if (!candidate.settings || typeof candidate.settings !== "object" || typeof candidate.updatedAt !== "string") {
    return undefined;
  }

  return {
    version: candidate.version ?? 1,
    settings: candidate.settings,
    updatedAt: candidate.updatedAt
  };
}

async function getStoredSettings(): Promise<Partial<AppSettings>> {
  const [localResult, syncResult] = await Promise.all([
    chrome.storage.local.get([SETTINGS_KEY, STORAGE_MODE_KEY, ARCHIVE_SYNC_MODE_KEY]),
    chrome.storage.sync.get([SETTINGS_KEY, STORAGE_MODE_KEY, ARCHIVE_SYNC_MODE_KEY])
  ]);

  const localStored = parseStoredSettings(localResult[SETTINGS_KEY]);
  const syncStored = parseStoredSettings(syncResult[SETTINGS_KEY]);
  const stored =
    localStored && syncStored
      ? new Date(syncStored.updatedAt).getTime() > new Date(localStored.updatedAt).getTime()
        ? syncStored
        : localStored
      : syncStored ?? localStored;

  const settings = stored?.settings ?? ((localResult[SETTINGS_KEY] as Partial<AppSettings> | undefined) ?? {});
  const localStorageMode = localResult[STORAGE_MODE_KEY];
  const syncStorageMode = syncResult[STORAGE_MODE_KEY];
  const localArchiveMode = localResult[ARCHIVE_SYNC_MODE_KEY];
  const syncArchiveMode = syncResult[ARCHIVE_SYNC_MODE_KEY];

  const resolvedStorageMode =
    settings.storageMode ??
    (syncStorageMode === "sync" ? "sync" : localStorageMode === "sync" ? "sync" : undefined);
  const resolvedArchiveMode =
    settings.archiveSyncMode ??
    ((syncArchiveMode === "follow_queue" || syncArchiveMode === "sync_enabled"
      ? syncArchiveMode
      : syncArchiveMode === "local_only"
        ? "local_only"
        : undefined) ??
      (localArchiveMode === "follow_queue" || localArchiveMode === "sync_enabled"
        ? localArchiveMode
        : localArchiveMode === "local_only"
          ? "local_only"
          : undefined));

  return {
    ...settings,
    storageMode: resolvedStorageMode,
    archiveSyncMode: resolvedArchiveMode as ArchiveSyncMode | undefined
  };
}

async function saveSettings(settings: AppSettings): Promise<void> {
  const payload: StoredSettings = {
    version: 1,
    settings,
    updatedAt: nowIso()
  };

  const mirrored = {
    [SETTINGS_KEY]: payload,
    [STORAGE_MODE_KEY]: settings.storageMode,
    [ARCHIVE_SYNC_MODE_KEY]: settings.archiveSyncMode
  };

  await Promise.all([chrome.storage.local.set(mirrored), chrome.storage.sync.set(mirrored)]);
}

async function loadStoredActiveState(settings: AppSettings): Promise<StoredActiveState | undefined> {
  const area = getArea(settings.storageMode);
  const stored = await area.get(APP_STATE_KEY);
  return stored[APP_STATE_KEY] as StoredActiveState | undefined;
}

async function loadStoredArchiveState(settings: AppSettings): Promise<StoredArchiveState | undefined> {
  const area = getArchiveArea(settings);
  const stored = await area.get(ARCHIVE_STATE_KEY);
  return stored[ARCHIVE_STATE_KEY] as StoredArchiveState | undefined;
}

async function saveStoredActiveState(items: QueueItem[], settings: AppSettings): Promise<void> {
  const payload: StoredActiveState = {
    version: 2,
    items: normalizeItems(items),
    updatedAt: nowIso()
  };

  if (settings.storageMode === "sync" && estimateSize(payload) > SYNC_WARNING_BYTES) {
    throw new Error("Sync storage is full. Clear some active tabs or switch back to local mode.");
  }

  await getArea(settings.storageMode).set({ [APP_STATE_KEY]: payload });
}

async function saveStoredArchiveState(completedItems: CompletedItem[], settings: AppSettings): Promise<void> {
  const payload: StoredArchiveState = {
    version: 1,
    completedItems: normalizeArchiveItems(completedItems),
    updatedAt: nowIso()
  };

  if (getArchiveArea(settings) === chrome.storage.sync && estimateSize(payload) > SYNC_WARNING_BYTES) {
    throw new Error("Archive sync storage is full. Switch archive history back to local only.");
  }

  await getArchiveArea(settings).set({ [ARCHIVE_STATE_KEY]: payload });
}

export async function getStorageMode(): Promise<StorageMode> {
  const settings = sanitizeSettings(await getStoredSettings());
  return settings.storageMode;
}

export async function getArchiveSyncMode(): Promise<ArchiveSyncMode> {
  const settings = sanitizeSettings(await getStoredSettings());
  return settings.archiveSyncMode;
}

export async function loadState(): Promise<AppState> {
  const settings = sanitizeSettings(await getStoredSettings());
  const active = await loadStoredActiveState(settings);
  const archive = await loadStoredArchiveState(settings);

  const migratedSettings =
    active?.settings && (!settings.storageMode || !settings.archiveSyncMode)
      ? sanitizeSettings({ ...active.settings, ...settings })
      : settings;

  const items = normalizeItems(active?.items ?? []);
  const completedItems = normalizeArchiveItems(archive?.completedItems ?? []);

  return {
    version: 2,
    items,
    completedItems,
    stats: computeCompletionStats(completedItems),
    settings: migratedSettings,
    updatedAt: nowIso()
  };
}

export async function saveState(state: AppState): Promise<AppState> {
  const settings = sanitizeSettings(state.settings);
  const normalizedItems = normalizeItems(state.items);
  const normalizedArchive = normalizeArchiveItems(state.completedItems);

  await saveStoredActiveState(normalizedItems, settings);
  await saveStoredArchiveState(normalizedArchive, settings);
  await saveSettings(settings);

  return {
    version: 2,
    items: normalizedItems,
    completedItems: normalizedArchive,
    stats: computeCompletionStats(normalizedArchive),
    settings,
    updatedAt: nowIso()
  };
}

export async function updateState(
  updater: (state: AppState) => AppState | Promise<AppState>
): Promise<AppState> {
  const current = await loadState();
  const next = await updater(current);
  return saveState(next);
}

export async function migrateStorageMode(nextMode: StorageMode): Promise<AppState> {
  const state = await loadState();
  return saveState({
    ...state,
    settings: {
      ...state.settings,
      storageMode: nextMode
    }
  });
}

export async function migrateArchiveSyncMode(nextMode: ArchiveSyncMode): Promise<AppState> {
  const state = await loadState();
  return saveState({
    ...state,
    settings: {
      ...state.settings,
      archiveSyncMode: nextMode
    }
  });
}
