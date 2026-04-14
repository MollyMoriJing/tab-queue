# Tab Queue

Chrome extension for turning unfinished tabs into a light, private queue you can reopen on purpose later.

## What It Does
- Save the current tab into a queue, then close it to free memory.
- Save all the other tabs in the current window in one step.
- Add a short note, priority, optional reminder, and optional 15 minute early reminder.
- Parse quick time input such as `Apr 17 8am`, `Fri 3pm PT`, or `tomorrow 2pm`.
- Manage saved tabs from a side panel with drag-and-drop bucket moves.
- Reopen from the queue, a reminder notification, or completed history.
- Keep data local by default, with optional Chrome Sync and no account system.

## Project Structure
- `public/manifest.json`: Chrome extension manifest
- `src/background/index.ts`: MV3 service worker, alarms, notifications, mutations
- `src/sidepanel/App.tsx`: queue management UI
- `src/shared/*`: types, storage, selectors, date helpers
- `docs/privacy.html`: public privacy policy page for Chrome Web Store submission

## Local Setup
1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run build
```

3. Load into Chrome:
- Open `chrome://extensions`
- Enable `Developer mode`
- Click `Load unpacked`
- Select the `dist` folder

## Notes
- Clicking the extension action opens the side panel.
- Default shortcut for quick-save is `Alt/Option + Shift + Q`.
- `Local` stores data only in the current Chrome profile.
- `Sync` uses Chrome's extension sync storage and only works across devices if Chrome Sync is on.
- Completed items are kept as lightweight history until you clear history.

## Verification
After installing the unpacked extension:
- Open a normal web page, click the extension icon, and save it.
- Confirm the tab closes and appears in the side panel.
- Try `Save all the other tabs in this window` and confirm current and pinned tabs are skipped.
- Set a reminder, wait for the notification or badge, then click it to reopen the page.
- Move items between `Today`, `This Week`, `Later`, and `Waiting`.
- Switch between `Local` and `Sync` storage modes from the side panel.
