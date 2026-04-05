import { useEffect, useMemo, useState } from "react";
import { BUCKET_LABELS } from "../shared/constants";
import { buildDueAtFromPreset, deriveBucketFromDueAt } from "../shared/date";
import { sendBackgroundMessage } from "../shared/messages";
import { bucketOptions } from "../shared/selectors";
import type { BucketId, Priority, ReminderPreset } from "../shared/types";

type TabPreview = {
  title: string;
  url: string;
};

const presetLabels: Array<{ value: ReminderPreset; label: string }> = [
  { value: "none", label: "No reminder" },
  { value: "tonight", label: "Tonight" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "weekend", label: "Weekend" },
  { value: "custom", label: "Custom time" }
];

function App() {
  const [tab, setTab] = useState<TabPreview | null>(null);
  const [note, setNote] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [bucket, setBucket] = useState<BucketId>("later");
  const [bucketTouched, setBucketTouched] = useState(false);
  const [reminderPreset, setReminderPreset] = useState<ReminderPreset>("none");
  const [customDueAt, setCustomDueAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([activeTab]) => {
      if (!activeTab?.url) {
        return;
      }

      setTab({
        title: activeTab.title || "Untitled tab",
        url: activeTab.url
      });
    });
  }, []);

  useEffect(() => {
    if (bucketTouched) {
      return;
    }

    const dueAt = buildDueAtFromPreset(reminderPreset, customDueAt || undefined);
    setBucket(deriveBucketFromDueAt(dueAt));
  }, [bucketTouched, customDueAt, reminderPreset]);

  const duePreview = useMemo(
    () => buildDueAtFromPreset(reminderPreset, customDueAt || undefined),
    [customDueAt, reminderPreset]
  );

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await sendBackgroundMessage({
      type: "CAPTURE_CURRENT_TAB",
      payload: {
        note,
        priority,
        bucket,
        reminderPreset,
        dueAt: customDueAt || undefined
      }
    });

    setSubmitting(false);
    if (!response.ok) {
      setError(response.error || "Unable to save the current tab.");
      return;
    }

    window.close();
  }

  async function handleOpenSidePanel() {
    setError(null);

    try {
      const currentWindow = await chrome.windows.getCurrent();
      if (!currentWindow.id) {
        throw new Error("Unable to find the current browser window.");
      }

      await chrome.sidePanel.open({ windowId: currentWindow.id });
      window.close();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to open the side panel.");
    }
  }

  return (
    <main className="app-shell" style={{ minWidth: 360 }}>
      <div className="panel stack" style={{ padding: 16 }}>
        <section className="hero panel stack">
          <span className="eyebrow">Tab Queue</span>
          <h1 className="headline">Close it now. Return on purpose.</h1>
          <p className="subtle" style={{ margin: 0 }}>
            Save this tab into a lightweight queue, then let the extension remind you when it matters.
          </p>
        </section>

        {tab ? (
          <section className="card stack">
            <div className="row-between">
              <div>
                <div className="eyebrow">Current Tab</div>
                <div className="item-title" style={{ marginTop: 6 }}>
                  {tab.title}
                </div>
              </div>
              <span className="pill">{BUCKET_LABELS[bucket]}</span>
            </div>
            <a className="linkish subtle" href={tab.url} target="_blank" rel="noreferrer">
              {tab.url}
            </a>
          </section>
        ) : (
          <div className="flash error">Open a normal web page to capture it.</div>
        )}

        <form className="stack" onSubmit={handleSave}>
          <div className="field">
            <label htmlFor="note">Short note</label>
            <textarea
              id="note"
              placeholder="Why does this tab matter later?"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <div className="field">
            <label>Reminder</label>
            <div className="preset-grid">
              {presetLabels.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={`preset ${reminderPreset === preset.value ? "active" : ""}`}
                  onClick={() => setReminderPreset(preset.value)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {reminderPreset === "custom" ? (
            <div className="field">
              <label htmlFor="dueAt">Custom time</label>
              <input
                id="dueAt"
                type="datetime-local"
                value={customDueAt}
                onChange={(event) => setCustomDueAt(event.target.value)}
              />
            </div>
          ) : null}

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="priority">Priority</label>
              <select
                id="priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value as Priority)}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>

            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="bucket">Bucket</label>
              <select
                id="bucket"
                value={bucket}
                onChange={(event) => {
                  setBucket(event.target.value as BucketId);
                  setBucketTouched(true);
                }}
              >
                {bucketOptions().map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {duePreview ? (
            <div className="flash">This tab will come back on {new Date(duePreview).toLocaleString()}.</div>
          ) : (
            <div className="flash">No reminder set. The tab will wait in Later until you reopen it.</div>
          )}

          {error ? <div className="flash error">{error}</div> : null}

          <button className="button" type="submit" disabled={!tab || submitting}>
            {submitting ? "Saving..." : "Save and close tab"}
          </button>
        </form>

        <div className="card subtle" style={{ fontSize: 13 }}>
          Quick-save shortcut: <strong>Alt/Option + Shift + Q</strong>. It stores the current tab in Later with no
          reminder, then closes it.
        </div>

        <button className="button secondary" type="button" onClick={() => void handleOpenSidePanel()}>
          Open side panel
        </button>
      </div>
    </main>
  );
}

export default App;
