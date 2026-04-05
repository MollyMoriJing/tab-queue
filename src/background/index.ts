import {
  ALARM_PREFIX,
  APP_STATE_KEY,
  ARCHIVE_STATE_KEY,
  ARCHIVE_SYNC_MODE_KEY,
  ITEM_LIMIT,
  STORAGE_MODE_KEY
} from "../shared/constants";
import { buildDueAtFromPreset, deriveBucketFromDueAt, nowIso } from "../shared/date";
import { parseVoiceTranscript, quickParse, suggestWithProviders } from "../shared/intelligence";
import {
  getArchiveSyncMode,
  getStorageMode,
  loadState,
  migrateArchiveSyncMode,
  migrateStorageMode,
  updateState
} from "../shared/storage";
import type { BackgroundRequest, BackgroundResponse } from "../shared/messages";
import type {
  AppState,
  BucketId,
  CapturePayload,
  CompletedItem,
  QueueItem,
  ReviewState,
  StorageMode,
  SuggestionResult
} from "../shared/types";

const NOTIFICATION_PREFIX = "tab-queue-notification:";

function ok(state: AppState): BackgroundResponse {
  return { ok: true, state };
}

function okReview(reviewState: ReviewState, state?: AppState): BackgroundResponse {
  return { ok: true, state, reviewState };
}

function okSuggestion(suggestion: SuggestionResult, state?: AppState): BackgroundResponse {
  return { ok: true, state, suggestion };
}

function fail(error: unknown): BackgroundResponse {
  return {
    ok: false,
    error: error instanceof Error ? error.message : "Unknown error"
  };
}

function isCapturableUrl(url?: string): url is string {
  return !!url && /^(https?|file):\/\//.test(url);
}

function alarmName(id: string): string {
  return `${ALARM_PREFIX}${id}`;
}

function notificationId(id: string): string {
  return `${NOTIFICATION_PREFIX}${id}`;
}

function extractIdFromAlarm(name: string): string | null {
  return name.startsWith(ALARM_PREFIX) ? name.slice(ALARM_PREFIX.length) : null;
}

function extractIdFromNotification(id: string): string | null {
  return id.startsWith(NOTIFICATION_PREFIX) ? id.slice(NOTIFICATION_PREFIX.length) : null;
}

function notificationIcon(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
    <rect width="128" height="128" rx="32" fill="#1f6f5f"/>
    <path d="M26 39h76v14H26zM26 59h52v14H26zM26 79h40v14H26z" fill="#f3f0e8"/>
    <circle cx="92" cy="86" r="18" fill="#f0b34a"/>
  </svg>`;

  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (!tab?.id || !isCapturableUrl(tab.url)) {
    throw new Error("This tab cannot be captured. Try a normal web page instead.");
  }

  return tab;
}

function reindexBucket(items: QueueItem[], bucket: BucketId): QueueItem[] {
  let order = 0;
  return items.map((item) => {
    if (item.bucket !== bucket) {
      return item;
    }

    const next = {
      ...item,
      order
    };
    order += 1;
    return next;
  });
}

function toReviewState(state: AppState): ReviewState {
  return {
    completedItems: state.completedItems,
    stats: state.stats
  };
}

async function scheduleAlarms(state: AppState): Promise<void> {
  const existing = await chrome.alarms.getAll();
  await Promise.all(
    existing
      .filter((alarm) => alarm.name.startsWith(ALARM_PREFIX))
      .map((alarm) => chrome.alarms.clear(alarm.name))
  );

  const dueItems = state.items.filter((item) => item.dueAt);
  await Promise.all(
    dueItems.map((item) =>
      chrome.alarms.create(alarmName(item.id), {
        when: Math.max(Date.now() + 1_000, new Date(item.dueAt!).getTime())
      })
    )
  );
}

async function notifyForItem(item: QueueItem): Promise<void> {
  await chrome.notifications.create(notificationId(item.id), {
    type: "basic",
    iconUrl: notificationIcon(),
    title: "Time to revisit this tab",
    message: item.title,
    contextMessage: item.note || "Tap to reopen and continue where you left off.",
    priority: 1
  });
}

async function captureCurrentTab(payload: CapturePayload, shouldCloseTab: boolean): Promise<AppState> {
  const tab = await getActiveTab();
  const dueAt = buildDueAtFromPreset(payload.reminderPreset, payload.dueAt);

  const state = await updateState((currentState) => {
    if (currentState.items.length >= ITEM_LIMIT) {
      throw new Error("Your active queue is full. Finish or remove a few tabs before saving more.");
    }

    const nextBucket = payload.bucket ?? deriveBucketFromDueAt(dueAt);
    const nextOrder =
      currentState.items
        .filter((item) => item.bucket === nextBucket)
        .reduce((max, item) => Math.max(max, item.order), -1) + 1;

    const newItem: QueueItem = {
      id: crypto.randomUUID(),
      url: tab.url!,
      title: tab.title || "Untitled tab",
      faviconUrl: tab.favIconUrl,
      createdAt: nowIso(),
      dueAt,
      bucket: nextBucket,
      priority: payload.priority,
      note: payload.note?.trim() || undefined,
      status: "pending",
      updatedAt: nowIso(),
      order: nextOrder
    };

    return {
      ...currentState,
      items: [...currentState.items, newItem]
    };
  });

  await scheduleAlarms(state);

  if (shouldCloseTab && tab.id) {
    await chrome.tabs.remove(tab.id);
  }

  return state;
}

async function openItem(id: string): Promise<AppState> {
  const state = await updateState((currentState) => {
    const item = currentState.items.find((entry) => entry.id === id);
    if (!item) {
      throw new Error("The saved tab no longer exists.");
    }

    return {
      ...currentState,
      items: currentState.items.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              status: "in_progress",
              updatedAt: nowIso()
            }
          : entry
      )
    };
  });

  const item = state.items.find((entry) => entry.id === id);
  if (!item) {
    throw new Error("The saved tab no longer exists.");
  }

  await chrome.tabs.create({ url: item.url, active: true });
  return state;
}

async function deleteItem(id: string): Promise<AppState> {
  const state = await updateState((currentState) => {
    const target = currentState.items.find((item) => item.id === id);
    if (!target) {
      return currentState;
    }

    const nextItems = currentState.items.filter((item) => item.id !== id);
    return {
      ...currentState,
      items: reindexBucket(nextItems, target.bucket)
    };
  });

  await chrome.alarms.clear(alarmName(id));
  return state;
}

async function doneItem(id: string): Promise<AppState> {
  const state = await updateState((currentState) => {
    const target = currentState.items.find((item) => item.id === id);
    if (!target) {
      return currentState;
    }

    const completedItem: CompletedItem = {
      id: crypto.randomUUID(),
      originalItemId: target.id,
      url: target.url,
      title: target.title,
      bucket: target.bucket,
      priority: target.priority,
      createdAt: target.createdAt,
      completedAt: nowIso(),
      dueAt: target.dueAt,
      note: target.note
    };

    const nextItems = currentState.items.filter((item) => item.id !== id);

    return {
      ...currentState,
      items: reindexBucket(nextItems, target.bucket),
      completedItems: [completedItem, ...currentState.completedItems]
    };
  });

  await chrome.alarms.clear(alarmName(id));
  return state;
}

async function snoozeItem(id: string, dueAt?: string): Promise<AppState> {
  const state = await updateState((currentState) => {
    const target = currentState.items.find((item) => item.id === id);
    if (!target) {
      throw new Error("The saved tab no longer exists.");
    }

    const nextBucket = dueAt ? deriveBucketFromDueAt(dueAt) : target.bucket;

    return {
      ...currentState,
      items: currentState.items.map((item) =>
        item.id === id
          ? {
              ...item,
              dueAt,
              bucket: nextBucket,
              updatedAt: nowIso()
            }
          : item
      )
    };
  });

  await scheduleAlarms(state);
  return state;
}

async function moveItem(id: string, bucket: BucketId, beforeId?: string): Promise<AppState> {
  const state = await updateState((currentState) => {
    const moving = currentState.items.find((item) => item.id === id);
    if (!moving) {
      throw new Error("The saved tab no longer exists.");
    }

    const remaining = currentState.items.filter((item) => item.id !== id);
    const sourceBucket = moving.bucket;
    const targetItems = remaining.filter((item) => item.bucket === bucket).sort((a, b) => a.order - b.order);
    const insertAt = beforeId ? Math.max(targetItems.findIndex((item) => item.id === beforeId), 0) : targetItems.length;
    const nextMoving: QueueItem = {
      ...moving,
      bucket,
      updatedAt: nowIso()
    };
    const reorderedTarget = [...targetItems];
    reorderedTarget.splice(insertAt, 0, nextMoving);

    const nextItems = remaining.filter((item) => item.bucket !== bucket).map((item) => ({ ...item }));

    reorderedTarget.forEach((item, index) => {
      nextItems.push({
        ...item,
        order: index
      });
    });

    const withSourceOrder = reindexBucket(nextItems, sourceBucket);
    const finalItems = reindexBucket(withSourceOrder, bucket);

    return {
      ...currentState,
      items: finalItems
    };
  });

  return state;
}

async function updateItem(
  id: string,
  patch: Partial<Pick<QueueItem, "note" | "priority" | "dueAt" | "bucket">>
): Promise<AppState> {
  const state = await updateState((currentState) => {
    const target = currentState.items.find((item) => item.id === id);
    if (!target) {
      throw new Error("The saved tab no longer exists.");
    }

    const hasDueAt = Object.prototype.hasOwnProperty.call(patch, "dueAt");
    const hasBucket = Object.prototype.hasOwnProperty.call(patch, "bucket");
    const nextDueAt = hasDueAt ? patch.dueAt : target.dueAt;
    const nextBucket = hasBucket ? patch.bucket! : hasDueAt ? deriveBucketFromDueAt(nextDueAt) : target.bucket;

    return {
      ...currentState,
      items: currentState.items.map((item) =>
        item.id === id
          ? {
              ...item,
              ...patch,
              dueAt: nextDueAt,
              bucket: nextBucket,
              updatedAt: nowIso()
            }
          : item
      )
    };
  });

  await scheduleAlarms(state);
  return state;
}

async function setStorageMode(storageMode: StorageMode): Promise<AppState> {
  const state = await migrateStorageMode(storageMode);
  await scheduleAlarms(state);
  return state;
}

async function setArchiveSyncMode(archiveSyncMode: AppState["settings"]["archiveSyncMode"]): Promise<AppState> {
  return migrateArchiveSyncMode(archiveSyncMode);
}

async function resetAllData(): Promise<AppState> {
  return updateState((currentState) => ({
    ...currentState,
    completedItems: []
  }));
}

async function bootstrap(): Promise<void> {
  const state = await loadState();
  await scheduleAlarms(state);
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

async function handleMessage(request: BackgroundRequest): Promise<BackgroundResponse> {
  try {
    if (request.type === "GET_STATE") {
      return ok(await loadState());
    }

    if (request.type === "GET_REVIEW_STATE") {
      const state = await loadState();
      return okReview(toReviewState(state), state);
    }

    if (request.type === "RESET_ALL_DATA") {
      const state = await resetAllData();
      await scheduleAlarms(state);
      return okReview(toReviewState(state), state);
    }

    if (request.type === "CAPTURE_CURRENT_TAB") {
      return ok(await captureCurrentTab(request.payload, true));
    }

    if (request.type === "OPEN_ITEM") {
      return ok(await openItem(request.id));
    }

    if (request.type === "DONE_ITEM") {
      return ok(await doneItem(request.id));
    }

    if (request.type === "DELETE_ITEM") {
      return ok(await deleteItem(request.id));
    }

    if (request.type === "SNOOZE_ITEM") {
      return ok(await snoozeItem(request.id, request.dueAt));
    }

    if (request.type === "MOVE_ITEM") {
      return ok(await moveItem(request.id, request.bucket, request.beforeId));
    }

    if (request.type === "SET_STORAGE_MODE") {
      return ok(await setStorageMode(request.storageMode));
    }

    if (request.type === "SET_ARCHIVE_SYNC_MODE") {
      return ok(await setArchiveSyncMode(request.archiveSyncMode));
    }

    if (request.type === "REQUEST_SMART_SUGGEST") {
      const suggestion = await suggestWithProviders(request.payload);
      return okSuggestion(suggestion);
    }

    if (request.type === "REQUEST_QUICK_PARSE") {
      const parsed = quickParse(request.payload);
      return {
        ok: true,
        voiceCapture: {
          note: parsed.note,
          dueHint: parsed.dueHint,
          transcriptSource: "manual_text"
        }
      };
    }

    if (request.type === "REQUEST_VOICE_PARSE") {
      return {
        ok: true,
        voiceCapture: parseVoiceTranscript(request.transcript, request.transcriptSource)
      };
    }

    if (request.type === "UPDATE_ITEM") {
      return ok(await updateItem(request.id, request.patch));
    }

    return fail(new Error("Unsupported message."));
  } catch (error) {
    return fail(error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});

chrome.runtime.onMessage.addListener((request: BackgroundRequest, _sender, sendResponse) => {
  void handleMessage(request).then(sendResponse);
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "quick-save-current-tab") {
    return;
  }

  void handleMessage({
    type: "CAPTURE_CURRENT_TAB",
    payload: {
      priority: "medium",
      reminderPreset: "none",
      bucket: "later"
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const id = extractIdFromAlarm(alarm.name);
  if (!id) {
    return;
  }

  void loadState().then((state) => {
    const item = state.items.find((entry) => entry.id === id);
    if (item) {
      void notifyForItem(item);
    }
  });
});

chrome.notifications.onClicked.addListener((id) => {
  const itemId = extractIdFromNotification(id);
  if (!itemId) {
    return;
  }

  void chrome.notifications.clear(id);
  void openItem(itemId);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  void (async () => {
    const currentMode = await getStorageMode();
    const archiveMode = await getArchiveSyncMode();
    const queueAreaMatches = (currentMode === "local" && areaName === "local") || (currentMode === "sync" && areaName === "sync");
    const archiveAreaMatches =
      (archiveMode === "local_only" && areaName === "local") ||
      (archiveMode === "sync_enabled" && areaName === "sync") ||
      (archiveMode === "follow_queue" && queueAreaMatches);

    if ((changes[APP_STATE_KEY] && queueAreaMatches) || changes[STORAGE_MODE_KEY]) {
      const state = await loadState();
      await scheduleAlarms(state);
    }

    if ((changes[ARCHIVE_STATE_KEY] && archiveAreaMatches) || changes[ARCHIVE_SYNC_MODE_KEY]) {
      await loadState();
    }
  })();
});

void bootstrap();
