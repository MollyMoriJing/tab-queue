export type BucketId = "today" | "week" | "later" | "waiting";
export type Priority = "low" | "medium" | "high";
export type QueueStatus = "pending" | "in_progress";
export type ReminderPreset = "tonight" | "tomorrow" | "weekend" | "custom" | "none";
export type StorageMode = "local" | "sync";
export type ArchiveSyncMode = "local_only" | "follow_queue" | "sync_enabled";
export type SuggestionSource = "rules" | "built_in_ai" | "cloud";
export type TranscriptSource = "speech_recognition" | "manual_text";

export interface QueueItem {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  createdAt: string;
  dueAt?: string;
  bucket: BucketId;
  priority: Priority;
  note?: string;
  status: QueueStatus;
  updatedAt: string;
  order: number;
}

export interface CompletedItem {
  id: string;
  originalItemId: string;
  url: string;
  title: string;
  bucket: BucketId;
  priority: Priority;
  createdAt: string;
  completedAt: string;
  dueAt?: string;
  note?: string;
}

export interface DueHint {
  preset: ReminderPreset;
  label: string;
  dueAt?: string;
}

export interface SuggestionResult {
  bucket: BucketId;
  priority: Priority;
  dueHint?: DueHint;
  confidence?: number;
  source: SuggestionSource;
}

export interface VoiceCaptureResult {
  note?: string;
  dueHint?: DueHint;
  transcriptSource: TranscriptSource;
}

export interface CompletionStats {
  completedCount: number;
  completedToday: number;
  currentStreak: number;
  topBucket?: BucketId;
  lastCompletedAt?: string;
}

export interface AppSettings {
  storageMode: StorageMode;
  archiveSyncMode: ArchiveSyncMode;
  maxActiveItems: number;
  maxArchiveItems: number;
}

export interface AppState {
  version: 2;
  items: QueueItem[];
  completedItems: CompletedItem[];
  stats: CompletionStats;
  settings: AppSettings;
  updatedAt: string;
}

export interface CapturePayload {
  note?: string;
  priority: Priority;
  bucket?: BucketId;
  reminderPreset: ReminderPreset;
  dueAt?: string;
}

export interface SuggestionInput {
  title: string;
  url: string;
  quickInput?: string;
  note?: string;
  dueAt?: string;
}

export interface QueueSummary {
  total: number;
  dueToday: number;
  overdue: number;
  inProgress: number;
}

export interface ReviewState {
  completedItems: CompletedItem[];
  stats: CompletionStats;
}
