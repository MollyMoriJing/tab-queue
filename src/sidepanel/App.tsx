import { useEffect, useMemo, useRef, useState } from "react";
import { BUCKET_LABELS } from "../shared/constants";
import {
  buildDueAtFromPreset,
  deriveBucketFromDueAt,
  formatDueLabel,
  isOverdue,
  toDateTimeLocalValue
} from "../shared/date";
import { dueHintToDueAt } from "../shared/intelligence";
import { sendBackgroundMessage } from "../shared/messages";
import {
  domainForUrl,
  getQueueSummary,
  getReviewHeadline,
  getTopBuckets,
  groupItemsByBucket
} from "../shared/selectors";
import { loadState } from "../shared/storage";
import type {
  AppState,
  ArchiveSyncMode,
  BucketId,
  CompletedItem,
  Priority,
  QueueItem,
  ReminderPreset,
  ReviewState,
  StorageMode,
  SuggestionResult
} from "../shared/types";

type ActiveTabPreview = {
  title: string;
  url: string;
};

type FlashState = {
  message: string;
  actionLabel?: string;
  action?: "review";
  error?: boolean;
};

type ViewMode = "queue" | "review";
type MicPermissionState = "unknown" | "requesting" | "granted" | "denied";
type CatMood = "calm" | "busy" | "frazzled";

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const source = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };

  return source.SpeechRecognition ?? source.webkitSpeechRecognition ?? null;
}

function BucketSection(props: {
  bucket: BucketId;
  items: QueueItem[];
  draggedId: string | null;
  onDropItem: (bucket: BucketId, beforeId?: string) => void;
  onEdit: (item: QueueItem) => void;
  onOpen: (id: string) => void;
  onDone: (id: string) => void;
  onDelete: (id: string) => void;
  onSnoozeTomorrow: (id: string) => void;
  setDraggedId: (id: string | null) => void;
}) {
  const { bucket, items, draggedId, onDelete, onDone, onDropItem, onEdit, onOpen, onSnoozeTomorrow, setDraggedId } =
    props;

  return (
    <section
      className="bucket-section stack"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (draggedId) {
          onDropItem(bucket);
        }
      }}
    >
      <div className="row-between">
        <div className="row">
          <span className="eyebrow">{BUCKET_LABELS[bucket]}</span>
          <span className="pill">{items.length}</span>
        </div>
      </div>

      <div className="bucket-list">
        {items.length === 0 ? (
          <div className="empty-state bucket-drop">Drop a tab here.</div>
        ) : (
          items.map((item) => (
            <article
              key={item.id}
              className={`item-card ${draggedId === item.id ? "dragging" : ""}`}
              draggable
              onDragStart={() => setDraggedId(item.id)}
              onDragEnd={() => setDraggedId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedId && draggedId !== item.id) {
                  onDropItem(bucket, item.id);
                }
              }}
            >
              <div className="row-between">
                <div>
                  <div className="item-title">{item.title}</div>
                  <div className="subtle" style={{ marginTop: 6, fontSize: 13 }}>
                    {domainForUrl(item.url)}
                  </div>
                </div>
                <div className="row" style={{ alignItems: "flex-start" }}>
                  <span className={`badge priority-${item.priority}`}>{item.priority}</span>
                  {isOverdue(item.dueAt) ? <span className="badge warn">overdue</span> : null}
                </div>
              </div>

              <div className="item-meta">
                <span className="badge">{item.status === "in_progress" ? "in progress" : "queued"}</span>
                <span className="badge">{formatDueLabel(item.dueAt)}</span>
              </div>

              {item.note ? <div className="note">{item.note}</div> : null}

              <div className="item-actions">
                <button className="button small" onClick={() => onOpen(item.id)}>
                  Open
                </button>
                <button className="button small secondary" onClick={() => onSnoozeTomorrow(item.id)}>
                  Tomorrow
                </button>
                <button className="button small ghost" onClick={() => onEdit(item)}>
                  Edit
                </button>
                <button className="button small warn" onClick={() => onDone(item.id)}>
                  Done
                </button>
                <button className="button small danger" onClick={() => onDelete(item.id)}>
                  Delete
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function ReviewItem({ item, onOpen }: { item: CompletedItem; onOpen: (url: string) => void }) {
  return (
    <article className="item-card">
      <div className="row-between">
        <div>
          <div className="item-title">{item.title}</div>
          <div className="subtle" style={{ marginTop: 6, fontSize: 13 }}>
            {domainForUrl(item.url)}
          </div>
        </div>
        <span className={`badge priority-${item.priority}`}>{item.priority}</span>
      </div>

      <div className="item-meta">
        <span className="badge">{BUCKET_LABELS[item.bucket]}</span>
        <span className="badge">Done {formatDueLabel(item.completedAt)}</span>
      </div>

      {item.note ? <div className="note">{item.note}</div> : null}

      <div className="item-actions">
        <button className="button small secondary" onClick={() => onOpen(item.url)}>
          Open again
        </button>
      </div>
    </article>
  );
}

function CatDoodle({ mood }: { mood: CatMood }) {
  const isFrazzled = mood === "frazzled";
  const isBusy = mood === "busy";

  return (
    <svg className="cat-doodle" viewBox="0 0 120 120" aria-hidden="true">
      <path
        d="M34 55 C34 38, 46 30, 60 34 C74 30, 86 38, 86 55 C86 76, 74 91, 60 91 C46 91, 34 76, 34 55 Z"
        fill="#fffdfd"
        stroke="none"
      />
      <path
        d="M34 55 C34 38, 46 30, 60 34 C74 30, 86 38, 86 55 C86 76, 74 91, 60 91 C46 91, 34 76, 34 55 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M44 39 L49 47 L41 47 Z" fill="#f3cad9" stroke="none" />
      <path d="M76 39 L79 47 L71 47 Z" fill="#f3cad9" stroke="none" />
      <path
        d="M38 51 L44 36 L52 48 M68 48 L76 36 L82 51"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse cx="43" cy="68" rx="9" ry="7" fill="rgba(245, 214, 225, 0.88)" />
      <ellipse cx="77" cy="68" rx="9" ry="7" fill="rgba(245, 214, 225, 0.88)" />
      {isFrazzled ? (
        <>
          <path d="M47 58 L53 64 M53 58 L47 64" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
          <path d="M67 58 L73 64 M73 58 L67 64" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
          <path
            d="M39 54 C35 57, 35 63, 38 67"
            fill="none"
            stroke="#7db5ff"
            strokeWidth="4"
            strokeLinecap="round"
          />
          <path d="M79 41 L87 49 M87 41 L79 49" stroke="#ef6262" strokeWidth="5" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="50" cy="60" r="4.4" fill="currentColor" />
          <circle cx="70" cy="60" r="4.4" fill="currentColor" />
        </>
      )}
      <path
        d={isFrazzled ? "M52 74 C56 71, 64 71, 68 74" : isBusy ? "M53 69 C55 72, 58 72, 60 69 C62 72, 65 72, 67 69" : "M53 68 C55 71, 58 71, 60 68 C62 71, 65 71, 67 68"}
        fill="none"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      <path
        d="M20 62 H34 M86 62 H100 M22 70 H35 M85 70 H98"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      <circle cx="60" cy="65.5" r="2.3" fill="currentColor" />
      <path
        d="M46 84 C46 79, 49 76, 52 77 C52 80, 51 82, 52 84"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      <path
        d="M68 84 C68 79, 71 76, 74 77 C74 80, 73 82, 74 84"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      <path
        d="M92 85 C107 84, 110 96, 100 102"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HeartFrame() {
  return (
    <svg className="heart-frame" viewBox="0 0 120 110" aria-hidden="true">
      <path
        d="M60 99 C53 91, 19 68, 19 40 C19 24, 31 14, 45 14 C54 14, 60 20, 60 20 C60 20, 66 14, 75 14 C89 14, 101 24, 101 40 C101 68, 67 91, 60 99 Z"
        fill="rgba(245, 223, 233, 0.72)"
        stroke="rgba(37, 41, 51, 0.12)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [reviewState, setReviewState] = useState<ReviewState | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("queue");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<FlashState | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<QueueItem | null>(null);
  const [savingMode, setSavingMode] = useState<StorageMode | null>(null);
  const [savingArchiveMode, setSavingArchiveMode] = useState<ArchiveSyncMode | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTabPreview | null>(null);
  const [showCaptureDetails, setShowCaptureDetails] = useState(false);
  const [quickInput, setQuickInput] = useState("");
  const [captureNote, setCaptureNote] = useState("");
  const [capturePriority, setCapturePriority] = useState<Priority>("medium");
  const [captureBucket, setCaptureBucket] = useState<BucketId>("later");
  const [captureDueAt, setCaptureDueAt] = useState("");
  const [capturePreset, setCapturePreset] = useState<ReminderPreset>("none");
  const [capturing, setCapturing] = useState(false);
  const [suggestion, setSuggestion] = useState<SuggestionResult | null>(null);
  const [noteTouched, setNoteTouched] = useState(false);
  const [priorityTouched, setPriorityTouched] = useState(false);
  const [bucketTouched, setBucketTouched] = useState(false);
  const [dueAtTouched, setDueAtTouched] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceSupported] = useState(() => !!getSpeechRecognitionCtor());
  const [micPermission, setMicPermission] = useState<MicPermissionState>("unknown");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef("");

  useEffect(() => {
    void refreshState();
    void refreshReviewState();
    void refreshActiveTab();
  }, []);

  useEffect(() => {
    if (!activeTab) {
      return;
    }

    setQuickInput("");
    setCaptureNote("");
    setCapturePriority("medium");
    setCaptureBucket("later");
    setCaptureDueAt("");
    setCapturePreset("none");
    setSuggestion(null);
    setShowCaptureDetails(false);
    setNoteTouched(false);
    setPriorityTouched(false);
    setBucketTouched(false);
    setDueAtTouched(false);
  }, [activeTab?.url]);

  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: chrome.storage.AreaName
    ) => {
      if (areaName === "local" || areaName === "sync") {
        void refreshState();
        void refreshReviewState();
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    const handleTabActivity = () => {
      void refreshActiveTab();
    };

    chrome.tabs.onActivated.addListener(handleTabActivity);
    chrome.tabs.onUpdated.addListener(handleTabActivity);
    chrome.windows.onFocusChanged.addListener(handleTabActivity);

    return () => {
      chrome.tabs.onActivated.removeListener(handleTabActivity);
      chrome.tabs.onUpdated.removeListener(handleTabActivity);
      chrome.windows.onFocusChanged.removeListener(handleTabActivity);
    };
  }, []);

  useEffect(() => {
    if (!flash) {
      return;
    }

    const timeout = window.setTimeout(() => setFlash(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [flash]);

  useEffect(() => {
    if (!activeTab) {
      return;
    }

    void applyQuickParse(activeTab.title, activeTab.url, quickInput, captureNote);
  }, [activeTab?.url, quickInput]);

  useEffect(() => {
    if (!activeTab || !captureNote.trim() || quickInput.trim() || dueAtTouched) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void applyNoteReminderParse(activeTab.title, activeTab.url, captureNote);
    }, 220);

    return () => window.clearTimeout(timeout);
  }, [activeTab?.url, captureNote, quickInput, dueAtTouched]);

  useEffect(() => {
    if (!activeTab) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void applySilentRefinement(activeTab.title, activeTab.url, captureNote, captureDueAt, quickInput);
    }, 320);

    return () => window.clearTimeout(timeout);
  }, [activeTab?.url, quickInput, captureNote, captureDueAt]);

  useEffect(() => {
    if (!editingItem?.note?.trim()) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void applyEditParse(editingItem.id, editingItem.title, editingItem.url, editingItem.note || "");
    }, 220);

    return () => window.clearTimeout(timeout);
  }, [editingItem?.id, editingItem?.note]);

  async function refreshState() {
    try {
      const nextState = await loadState();
      setState(nextState);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load your queue.");
    }
  }

  async function refreshReviewState() {
    const response = await sendBackgroundMessage({ type: "GET_REVIEW_STATE" });
    if (response.ok && response.reviewState) {
      setReviewState(response.reviewState);
    }
  }

  async function refreshActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
        setActiveTab(null);
        return;
      }

      setActiveTab({
        title: tab.title || "Untitled tab",
        url: tab.url
      });
    } catch {
      setActiveTab(null);
    }
  }

  async function runAction(action: Promise<Awaited<ReturnType<typeof sendBackgroundMessage>>>, success?: FlashState) {
    setError(null);
    const response = await action;
    if (!response.ok || !response.state) {
      setError(response.error || "Action failed.");
      return false;
    }

    setState(response.state);
    if (response.reviewState) {
      setReviewState(response.reviewState);
    } else {
      setReviewState({
        completedItems: response.state.completedItems,
        stats: response.state.stats
      });
    }

    if (success) {
      setFlash(success);
    }

    return true;
  }

  async function handleStorageMode(storageMode: StorageMode) {
    setSavingMode(storageMode);
    await runAction(sendBackgroundMessage({ type: "SET_STORAGE_MODE", storageMode }), {
      message: `Queue storage changed to ${storageMode}.`
    });
    setSavingMode(null);
  }

  async function handleArchiveSyncMode(archiveSyncMode: ArchiveSyncMode) {
    setSavingArchiveMode(archiveSyncMode);
    await runAction(sendBackgroundMessage({ type: "SET_ARCHIVE_SYNC_MODE", archiveSyncMode }), {
      message: "Archive sync preference updated."
    });
    setSavingArchiveMode(null);
  }

  async function handleOpenArchivedUrl(url: string) {
    try {
      await chrome.tabs.create({ url, active: true });
      setFlash({ message: "Reopened." });
    } catch {
      setError("Could not reopen that page.");
    }
  }

  async function handleCapture(reminderPreset: ReminderPreset) {
    setCapturing(true);
    setError(null);

    const normalizedCapturedDueAt = captureDueAt ? new Date(captureDueAt).toISOString() : undefined;
    const effectivePreset = reminderPreset === "none" && normalizedCapturedDueAt ? "custom" : reminderPreset;
    const dueAt =
      effectivePreset === "custom"
        ? normalizedCapturedDueAt
        : undefined;
    const bucket =
      effectivePreset === "custom"
        ? normalizedCapturedDueAt
          ? deriveBucketFromDueAt(normalizedCapturedDueAt)
          : captureBucket
        : deriveBucketFromDueAt(buildDueAtFromPreset(effectivePreset, dueAt));

    const saved = await runAction(
      sendBackgroundMessage({
        type: "CAPTURE_CURRENT_TAB",
        payload: {
          note: captureNote || undefined,
          priority: capturePriority,
          bucket,
          reminderPreset: effectivePreset,
          dueAt
        }
      }),
      { message: "Tab captured and closed." }
    );

    setCapturing(false);
    if (saved) {
      setQuickInput("");
      setCaptureNote("");
      setCapturePriority("medium");
      setCaptureBucket("later");
      setCaptureDueAt("");
      setCapturePreset("none");
      setShowCaptureDetails(false);
      setSuggestion(null);
      setNoteTouched(false);
      setPriorityTouched(false);
      setBucketTouched(false);
      setDueAtTouched(false);
      setActiveTab(null);
      await refreshActiveTab();
    }
  }

  async function applyQuickParse(title: string, url: string, rawQuickInput: string, currentNote: string) {
    const parsed = await sendBackgroundMessage({
      type: "REQUEST_QUICK_PARSE",
      payload: {
        title,
        url,
        quickInput: rawQuickInput,
        note: currentNote,
        dueAt: captureDueAt ? new Date(captureDueAt).toISOString() : undefined
      }
    });

    const parsedNote = parsed.voiceCapture?.note ?? "";
    const parsedDueAt = toDateTimeLocalValue(dueHintToDueAt(parsed.voiceCapture?.dueHint));

    if (!noteTouched) {
      setCaptureNote(parsedNote);
    }

    if (!dueAtTouched) {
      setCaptureDueAt(parsedDueAt);
      setCapturePreset(parsedDueAt ? "custom" : "none");
    }
  }

  async function applyNoteReminderParse(title: string, url: string, rawNote: string) {
    const parsed = await sendBackgroundMessage({
      type: "REQUEST_QUICK_PARSE",
      payload: {
        title,
        url,
        quickInput: rawNote
      }
    });

    const parsedDueAt = toDateTimeLocalValue(dueHintToDueAt(parsed.voiceCapture?.dueHint));
    if (!parsedDueAt) {
      return;
    }

    setCaptureDueAt(parsedDueAt);
    setCapturePreset("custom");
  }

  async function applySilentRefinement(
    title: string,
    url: string,
    currentNote: string,
    currentDueAt: string,
    rawQuickInput: string
  ) {
    const response = await sendBackgroundMessage({
      type: "REQUEST_SMART_SUGGEST",
      payload: {
        title,
        url,
        quickInput: rawQuickInput,
        note: currentNote,
        dueAt: currentDueAt ? new Date(currentDueAt).toISOString() : undefined
      }
    });

    if (!response.ok || !response.suggestion) {
      return;
    }

    const nextSuggestion = response.suggestion;
    setSuggestion(nextSuggestion);

    if (!priorityTouched) {
      setCapturePriority(nextSuggestion.priority);
    }

    if (!bucketTouched) {
      setCaptureBucket(nextSuggestion.bucket);
    }

    if (!dueAtTouched) {
      setCaptureDueAt(toDateTimeLocalValue(dueHintToDueAt(nextSuggestion.dueHint)));
    }
  }

  async function applyEditParse(id: string, title: string, url: string, rawNote: string) {
    const parsed = await sendBackgroundMessage({
      type: "REQUEST_QUICK_PARSE",
      payload: {
        title,
        url,
        quickInput: rawNote
      }
    });

    const parsedDueAt = dueHintToDueAt(parsed.voiceCapture?.dueHint);
    if (!parsedDueAt) {
      return;
    }

    setEditingItem((current) => {
      if (!current || current.id !== id) {
        return current;
      }

      return {
        ...current,
        dueAt: parsedDueAt,
        bucket: deriveBucketFromDueAt(parsedDueAt)
      };
    });
  }

  async function applyVoiceTranscript(transcript: string) {
    const response = await sendBackgroundMessage({
      type: "REQUEST_VOICE_PARSE",
      transcript,
      transcriptSource: "speech_recognition"
    });

    if (!response.ok || !response.voiceCapture) {
      setError(response.error || "Could not use that voice note.");
      return;
    }

    setShowCaptureDetails(true);
    setCaptureNote(response.voiceCapture.note || "");
    setCaptureDueAt(toDateTimeLocalValue(dueHintToDueAt(response.voiceCapture.dueHint)));
    if (response.voiceCapture.dueHint?.dueAt) {
      setCaptureBucket(deriveBucketFromDueAt(response.voiceCapture.dueHint.dueAt));
    }
    setFlash({ message: "Voice note applied to this capture." });
  }

  function stopListening() {
    recognitionRef.current?.stop();
  }

  async function ensureMicrophonePermission(): Promise<boolean> {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Microphone access is not available in this browser view.");
      return false;
    }

    if (micPermission === "granted") {
      return true;
    }

    setMicPermission("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMicPermission("granted");
      return true;
    } catch {
      setMicPermission("denied");
      setError("Microphone access is blocked. Allow mic access in Chrome, then try again.");
      return false;
    }
  }

  async function startListening() {
    const SpeechRecognition = getSpeechRecognitionCtor();
    if (!SpeechRecognition || listening) {
      if (listening) {
        stopListening();
      }
      return;
    }

    const hasPermission = await ensureMicrophonePermission();
    if (!hasPermission) {
      return;
    }

    transcriptRef.current = "";
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      transcriptRef.current = transcript;
    };
    recognition.onerror = (event) => {
      recognitionRef.current = null;
      setListening(false);
      if (event.error === "not-allowed") {
        setMicPermission("denied");
        setError("Microphone access is blocked. Allow mic access in Chrome, then try again.");
        return;
      }

      setError(`Voice capture stopped: ${event.error}.`);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      if (transcriptRef.current) {
        void applyVoiceTranscript(transcriptRef.current);
      }
    };

    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  const summary = useMemo(() => (state ? getQueueSummary(state.items) : null), [state]);
  const grouped = useMemo(() => (state ? groupItemsByBucket(state.items) : null), [state]);
  const currentEditDueAt = editingItem ? toDateTimeLocalValue(editingItem.dueAt) : "";
  const completedItems = reviewState?.completedItems ?? state?.completedItems ?? [];
  const completionStats = reviewState?.stats ?? state?.stats ?? null;
  const topBuckets = useMemo(() => getTopBuckets(completedItems), [completedItems]);
  const catMood: CatMood =
    summary && (summary.overdue >= 2 || summary.total >= 12)
      ? "frazzled"
      : summary && (summary.overdue >= 1 || summary.dueToday >= 3 || summary.total >= 7)
        ? "busy"
        : "calm";
  const catStatus =
    catMood === "frazzled"
      ? "Too many open loops."
      : catMood === "busy"
        ? `${summary?.dueToday || summary?.total || 0} tabs need a return.`
        : "All clear today.";
  const visibleBuckets = grouped
    ? (Object.keys(grouped) as BucketId[]).filter((bucket) => grouped[bucket].length > 0)
    : [];
  const emptyBuckets = grouped
    ? (Object.keys(grouped) as BucketId[]).filter((bucket) => grouped[bucket].length === 0)
    : [];

  function exportDataBackup() {
    if (!state) {
      return;
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      queue: state.items,
      completed: completedItems,
      stats: completionStats,
      settings: state.settings
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tab-queue-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setFlash({ message: "Backup exported." });
  }

  async function handleResetAllData() {
    const confirmed = window.confirm("Clear completed history from Tab Queue? Unfinished tabs will stay in your queue.");
    if (!confirmed) {
      return;
    }

    await runAction(sendBackgroundMessage({ type: "RESET_ALL_DATA" }), {
      message: "Completed history cleared."
    });
    setViewMode("queue");
  }

  const resolvedDueAt = captureDueAt ? new Date(captureDueAt).toISOString() : undefined;
  const previewDueAt =
    capturePreset !== "none" && capturePreset !== "custom"
      ? buildDueAtFromPreset(capturePreset)
      : resolvedDueAt;
  const previewBucket = previewDueAt ? deriveBucketFromDueAt(previewDueAt) : captureBucket;
  const activeDomain = activeTab ? domainForUrl(activeTab.url) : "";
  const statusSummary = previewDueAt
    ? `Will remind ${formatDueLabel(previewDueAt)} · ${BUCKET_LABELS[previewBucket]}`
    : `Will save to ${BUCKET_LABELS[previewBucket]} · ${capturePriority}`;

  return (
    <main className="app-shell">
      <div className="stack">
        <section className="panel hero stack">
          <div className="hero-top">
            <div className="hero-copy">
              <span className="eyebrow">Tab Queue</span>
              <h1 className="headline">
                <span>Tabs, but</span>
                <span>calmer.</span>
              </h1>
              <p className="hero-note">{catStatus}</p>
            </div>
            <div className={`hero-art ${catMood}`} aria-hidden="true">
              <HeartFrame />
              <div className="cat-bubble">
                {catMood === "frazzled" ? "eep" : catMood === "busy" ? "hm" : "mrrp"}
              </div>
              <CatDoodle mood={catMood} />
            </div>
          </div>
          <div className="hero-meta">
            <div className="segment">
              <button className={viewMode === "queue" ? "active" : ""} onClick={() => setViewMode("queue")}>
                Queue
              </button>
              <button className={viewMode === "review" ? "active" : ""} onClick={() => setViewMode("review")}>
                Review
              </button>
            </div>
            <div className="summary-strip" aria-label="Queue summary">
              <span className="summary-pill">{summary?.total ?? 0} active</span>
              <span className="summary-pill">{summary?.dueToday ?? 0} due today</span>
              <span className="summary-pill">{completionStats?.completedToday ?? 0} done</span>
            </div>
          </div>
        </section>

        {flash ? (
          <div className={`flash ${flash.error ? "error" : ""} row-between`}>
            <span>{flash.message}</span>
            {flash.action === "review" ? (
              <button className="button small ghost" onClick={() => setViewMode("review")}>
                {flash.actionLabel || "Review"}
              </button>
            ) : null}
          </div>
        ) : null}

        {error ? <div className="flash error">{error}</div> : null}

        {viewMode === "queue" ? (
          <>
            {state ? (
              <section className="capture-card stack">
                <div className="capture-header">
                  <div>
                    <div className="eyebrow">Now</div>
                    <div className="capture-title">
                      {activeTab ? activeTab.title : "Open a normal web page to capture it."}
                    </div>
                  </div>
                  <button className="button small ghost details-toggle" onClick={() => setShowCaptureDetails((value) => !value)}>
                    {showCaptureDetails ? "Less" : "Details"}
                  </button>
                </div>

                {activeTab ? (
                  <>
                    <div className="capture-url">{activeDomain}</div>

                    <div className="field">
                      <label htmlFor="quick-input">What / when</label>
                      <input
                        className="quick-input"
                        id="quick-input"
                        type="text"
                        placeholder="Fri 3pm reply"
                        value={quickInput}
                        onChange={(event) => setQuickInput(event.target.value)}
                      />
                    </div>

                    <div className="field">
                      <label>Priority</label>
                      <div className="priority-row">
                        <button
                          className={`priority-chip low ${capturePriority === "low" ? "active" : ""}`}
                          onClick={() => {
                            setCapturePriority("low");
                            setPriorityTouched(true);
                          }}
                        >
                          Low
                        </button>
                        <button
                          className={`priority-chip medium ${capturePriority === "medium" ? "active" : ""}`}
                          onClick={() => {
                            setCapturePriority("medium");
                            setPriorityTouched(true);
                          }}
                        >
                          Medium
                        </button>
                        <button
                          className={`priority-chip high ${capturePriority === "high" ? "active" : ""}`}
                          onClick={() => {
                            setCapturePriority("high");
                            setPriorityTouched(true);
                          }}
                        >
                          High
                        </button>
                      </div>
                    </div>

                    <div className="capture-presets">
                      <button
                        className={`chip-toggle ${capturePreset === "none" ? "active" : ""}`}
                        onClick={() => {
                          setCapturePreset("none");
                          setCaptureDueAt("");
                          setDueAtTouched(true);
                          setCaptureBucket("later");
                        }}
                      >
                        Later
                      </button>
                      <button
                        className={`chip-toggle ${capturePreset === "tonight" ? "active" : ""}`}
                        onClick={() => {
                          setCapturePreset("tonight");
                          setDueAtTouched(true);
                        }}
                      >
                        Tonight
                      </button>
                      <button
                        className={`chip-toggle ${capturePreset === "tomorrow" ? "active" : ""}`}
                        onClick={() => {
                          setCapturePreset("tomorrow");
                          setDueAtTouched(true);
                        }}
                      >
                        Tomorrow
                      </button>
                      <button
                        className={`chip-toggle ${capturePreset === "weekend" ? "active" : ""}`}
                        onClick={() => {
                          setCapturePreset("weekend");
                          setDueAtTouched(true);
                        }}
                      >
                        Weekend
                      </button>
                      {capturePreset === "custom" || !!captureDueAt ? (
                        <button className="chip-toggle active" disabled>
                          Custom
                        </button>
                      ) : null}
                    </div>

                    <div className="field">
                      <label htmlFor="capture-reminder-inline">Reminder</label>
                      <input
                        id="capture-reminder-inline"
                        type="datetime-local"
                        value={captureDueAt}
                        onChange={(event) => {
                          setCaptureDueAt(event.target.value);
                          setCapturePreset(event.target.value ? "custom" : "none");
                          setDueAtTouched(true);
                          if (event.target.value) {
                            setCaptureBucket(deriveBucketFromDueAt(new Date(event.target.value).toISOString()));
                          }
                        }}
                      />
                    </div>

                    <button className="button save-button" disabled={capturing} onClick={() => void handleCapture(capturePreset)}>
                      {capturing ? "Saving..." : "Save"}
                    </button>

                    <div className="capture-status compact">
                      {suggestion?.source === "built_in_ai" ? "Refined" : "Ready"} · {statusSummary}
                    </div>

                    {showCaptureDetails ? (
                      <>
                        <div className="field">
                          <label htmlFor="capture-note">Note</label>
                          <textarea
                            id="capture-note"
                            placeholder="Why do you want to come back to this page?"
                            value={captureNote}
                            onChange={(event) => {
                              setCaptureNote(event.target.value);
                              setNoteTouched(true);
                            }}
                          />
                        </div>

                        <div className="row" style={{ gap: 12 }}>
                          <div className="field" style={{ flex: 1 }}>
                            <label htmlFor="capture-bucket">Bucket</label>
                            <select
                              id="capture-bucket"
                              value={captureBucket}
                              onChange={(event) => {
                                setCaptureBucket(event.target.value as BucketId);
                                setBucketTouched(true);
                              }}
                            >
                              {Object.entries(BUCKET_LABELS).map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div className="field">
                          <label htmlFor="capture-dueAt">Custom reminder</label>
                          <input
                            id="capture-dueAt"
                            type="datetime-local"
                            value={captureDueAt}
                            onChange={(event) => {
                              setCaptureDueAt(event.target.value);
                              setDueAtTouched(true);
                              if (event.target.value) {
                                setCaptureBucket(
                                  deriveBucketFromDueAt(new Date(event.target.value).toISOString())
                                );
                                setBucketTouched(true);
                              }
                            }}
                          />
                        </div>

                        <div className="row" style={{ flexWrap: "wrap" }}>
                          <button
                            className="button small ghost"
                            disabled={!voiceSupported || micPermission === "requesting"}
                            onClick={() => void startListening()}
                          >
                            {!voiceSupported
                              ? "Voice unavailable"
                              : micPermission === "requesting"
                                ? "Allowing mic..."
                                : listening
                                  ? "Stop listening"
                                  : micPermission === "granted"
                                    ? "Press to talk"
                                    : "Enable mic"}
                          </button>
                          <span className="subtle" style={{ fontSize: 12 }}>
                            Fills note + time only.
                          </span>
                        </div>

                        <div className="row">
                          <button className="button secondary" disabled={capturing} onClick={() => void handleCapture("custom")}>
                            Save with custom time
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="capture-hint">Example: Apr 17 8am</div>
                    )}
                  </>
                ) : (
                  <div className="empty-state">Open a normal page, then tap the extension again.</div>
                )}
              </section>
            ) : null}

            {editingItem ? (
              <section className="card stack">
                <div className="row-between">
                  <div>
                    <div className="eyebrow">Editing</div>
                    <div className="item-title">{editingItem.title}</div>
                  </div>
                  <button className="button small ghost" onClick={() => setEditingItem(null)}>
                    Close
                  </button>
                </div>

                <div className="field">
                  <label htmlFor="edit-note">Note</label>
                  <textarea
                    id="edit-note"
                    value={editingItem.note || ""}
                    onChange={(event) =>
                      setEditingItem({
                        ...editingItem,
                        note: event.target.value
                      })
                    }
                  />
                </div>

                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label htmlFor="edit-priority">Priority</label>
                    <select
                      id="edit-priority"
                      value={editingItem.priority}
                      onChange={(event) =>
                        setEditingItem({
                          ...editingItem,
                          priority: event.target.value as Priority
                        })
                      }
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>

                  <div className="field" style={{ flex: 1 }}>
                    <label htmlFor="edit-bucket">Bucket</label>
                    <select
                      id="edit-bucket"
                      value={editingItem.bucket}
                      onChange={(event) =>
                        setEditingItem({
                          ...editingItem,
                          bucket: event.target.value as BucketId
                        })
                      }
                    >
                      {Object.entries(BUCKET_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="edit-dueAt">Reminder</label>
                  <input
                    id="edit-dueAt"
                    type="datetime-local"
                    value={currentEditDueAt}
                    onChange={(event) => {
                      setEditingItem({
                        ...editingItem,
                        dueAt: event.target.value ? new Date(event.target.value).toISOString() : undefined
                      });
                    }}
                  />
                </div>

                <div className="row">
                  <button
                    className="button"
                    onClick={async () => {
                      const saved = await runAction(
                        sendBackgroundMessage({
                          type: "UPDATE_ITEM",
                          id: editingItem.id,
                          patch: {
                            note: editingItem.note,
                            priority: editingItem.priority,
                            dueAt: editingItem.dueAt,
                            bucket: editingItem.bucket
                          }
                        }),
                        { message: "Updated." }
                      );

                      if (saved) {
                        setEditingItem(null);
                      }
                    }}
                  >
                    Save changes
                  </button>
                  <button className="button secondary" onClick={() => setEditingItem(null)}>
                    Cancel
                  </button>
                </div>
              </section>
            ) : null}

            {grouped ? (
              visibleBuckets.length > 0 ? (
                <>
                  {visibleBuckets.map((bucket) => (
                <BucketSection
                  key={bucket}
                  bucket={bucket}
                  items={grouped[bucket]}
                  draggedId={draggedId}
                  setDraggedId={setDraggedId}
                  onDropItem={(targetBucket, beforeId) =>
                    void runAction(
                      sendBackgroundMessage({
                        type: "MOVE_ITEM",
                        id: draggedId!,
                        bucket: targetBucket,
                        beforeId
                      }),
                      { message: "Moved." }
                    )
                  }
                  onEdit={setEditingItem}
                  onOpen={(id) => void runAction(sendBackgroundMessage({ type: "OPEN_ITEM", id }), { message: "Reopened." })}
                  onDone={(id) =>
                    void runAction(sendBackgroundMessage({ type: "DONE_ITEM", id }), {
                      message: "1 tab completed today.",
                      action: "review",
                      actionLabel: "Review"
                    })
                  }
                  onDelete={(id) =>
                    void runAction(sendBackgroundMessage({ type: "DELETE_ITEM", id }), {
                      message: "Removed."
                    })
                  }
                  onSnoozeTomorrow={(id) =>
                    void runAction(
                      sendBackgroundMessage({
                        type: "SNOOZE_ITEM",
                        id,
                        dueAt: buildDueAtFromPreset("tomorrow")
                      }),
                      { message: "Moved to tomorrow." }
                    )
                  }
                />
                  ))}
                  {emptyBuckets.length > 0 ? (
                    <section className="card compact-buckets">
                      {emptyBuckets.map((bucket) => (
                        <div key={bucket} className="compact-bucket-row">
                          <span className="eyebrow">{BUCKET_LABELS[bucket]}</span>
                          <span className="pill">0</span>
                        </div>
                      ))}
                    </section>
                  ) : null}
                </>
              ) : (
                <section className="card">
                  <div className="empty-state">Queue is clear.</div>
                </section>
              )
            ) : (
              <div className="empty-state">Loading your queue…</div>
            )}

            {state ? (
              <section className="card compact-settings">
                <div className="compact-settings-copy">
                  <span className="eyebrow">Storage</span>
                  <span className="subtle">Local: only on this device</span>
                  <span className="subtle">Sync: across your Chrome devices</span>
                </div>
                <div className="toggle" aria-label="Storage mode">
                  <button
                    className={state.settings.storageMode === "local" ? "active" : ""}
                    disabled={!!savingMode}
                    onClick={() => void handleStorageMode("local")}
                  >
                    Local
                  </button>
                  <button
                    className={state.settings.storageMode === "sync" ? "active" : ""}
                    disabled={!!savingMode}
                    onClick={() => void handleStorageMode("sync")}
                  >
                    Sync
                  </button>
                </div>
              </section>
            ) : null}
          </>
        ) : (
          <>
            <section className="card stack">
              <div className="row-between">
                <div>
                  <div className="eyebrow">Review</div>
                  <div>{getReviewHeadline(completedItems)}</div>
                  <div className="subtle" style={{ fontSize: 13, marginTop: 6 }}>
                    Same as queue: match the queue setting
                  </div>
                </div>
                {state ? (
                  <div className="toggle" aria-label="Archive sync mode">
                    <button
                      className={state.settings.archiveSyncMode === "local_only" ? "active" : ""}
                      disabled={!!savingArchiveMode}
                      onClick={() => void handleArchiveSyncMode("local_only")}
                    >
                      Local
                    </button>
                    <button
                      className={state.settings.archiveSyncMode === "follow_queue" ? "active" : ""}
                      disabled={!!savingArchiveMode}
                      onClick={() => void handleArchiveSyncMode("follow_queue")}
                    >
                      Same as queue
                    </button>
                    <button
                      className={state.settings.archiveSyncMode === "sync_enabled" ? "active" : ""}
                      disabled={!!savingArchiveMode}
                      onClick={() => void handleArchiveSyncMode("sync_enabled")}
                    >
                      Sync
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="subtle" style={{ fontSize: 13 }}>
                Done keeps history. Delete does not.
              </div>
            </section>

            <section className="card stack">
              <div className="row-between">
                <div>
                  <div className="eyebrow">Data</div>
                  <div>Private and exportable.</div>
                </div>
                <div className="row">
                  <button className="button small ghost" onClick={exportDataBackup}>
                    Export backup
                  </button>
                  <button className="button small danger" onClick={() => void handleResetAllData()}>
                    Clear history
                  </button>
                </div>
              </div>
              <div className="subtle" style={{ fontSize: 13 }}>
                Stored in your Chrome profile. This only clears completed items.
              </div>
            </section>

            {completionStats ? (
              <section className="card stack">
                <div className="stats-grid">
                  <div className="stat">
                    <span className="eyebrow">Completed</span>
                    <strong>{completionStats.completedCount}</strong>
                    <span className="subtle">in history</span>
                  </div>
                  <div className="stat">
                    <span className="eyebrow">Today</span>
                    <strong>{completionStats.completedToday}</strong>
                    <span className="subtle">done today</span>
                  </div>
                </div>
                {topBuckets.length > 0 ? (
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    {topBuckets.map((entry) => (
                      <span key={entry.bucket} className="badge">
                        {BUCKET_LABELS[entry.bucket]} {entry.count}
                      </span>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}

            <section className="card stack">
              <div className="row-between">
                <div className="eyebrow">Recent completions</div>
                <button className="button small ghost" onClick={() => setViewMode("queue")}>
                  Queue
                </button>
              </div>
              {completedItems.length === 0 ? (
                <div className="empty-state">No completed tabs yet.</div>
              ) : (
                <div className="bucket-list">
                  {completedItems.slice(0, 12).map((item) => (
                    <ReviewItem key={item.id} item={item} onOpen={handleOpenArchivedUrl} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

export default App;
