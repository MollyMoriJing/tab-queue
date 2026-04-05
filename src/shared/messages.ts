import type {
  AppState,
  CapturePayload,
  BucketId,
  QueueItem,
  ReviewState,
  StorageMode,
  SuggestionInput,
  SuggestionResult,
  VoiceCaptureResult,
  ArchiveSyncMode,
  TranscriptSource
} from "./types";

export type BackgroundRequest =
  | { type: "GET_STATE" }
  | { type: "GET_REVIEW_STATE" }
  | { type: "RESET_ALL_DATA" }
  | { type: "CAPTURE_CURRENT_TAB"; payload: CapturePayload }
  | { type: "OPEN_ITEM"; id: string }
  | { type: "DONE_ITEM"; id: string }
  | { type: "DELETE_ITEM"; id: string }
  | { type: "SNOOZE_ITEM"; id: string; dueAt?: string }
  | { type: "MOVE_ITEM"; id: string; bucket: BucketId; beforeId?: string }
  | { type: "SET_STORAGE_MODE"; storageMode: StorageMode }
  | { type: "SET_ARCHIVE_SYNC_MODE"; archiveSyncMode: ArchiveSyncMode }
  | { type: "REQUEST_SMART_SUGGEST"; payload: SuggestionInput }
  | { type: "REQUEST_QUICK_PARSE"; payload: SuggestionInput }
  | { type: "REQUEST_VOICE_PARSE"; transcript: string; transcriptSource: TranscriptSource }
  | { type: "UPDATE_ITEM"; id: string; patch: Partial<Pick<QueueItem, "note" | "priority" | "dueAt" | "bucket">> };

export interface BackgroundResponse {
  ok: boolean;
  state?: AppState;
  reviewState?: ReviewState;
  suggestion?: SuggestionResult;
  voiceCapture?: VoiceCaptureResult;
  error?: string;
}

export async function sendBackgroundMessage(request: BackgroundRequest): Promise<BackgroundResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(request, (response?: BackgroundResponse) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }

      resolve(
        response ?? {
          ok: false,
          error: "No response from extension background worker."
        }
      );
    });
  });
}
