# Tab Queue

Chrome Extension for turning unfinished tabs into a light, private queue that you can reopen on purpose later.

## What It Does
- Save the current tab into a queue, then close it to free memory.
- Add a short note, priority, bucket, and optional reminder time.
- Manage saved tabs from a side panel with drag-and-drop bucket moves.
- Reopen from the queue or from a reminder notification.
- Keep data local by default, with optional Chrome Sync mode and no account system.

## Project Structure
- `public/manifest.json`: Chrome extension manifest
- `src/background/index.ts`: MV3 service worker, alarms, notifications, mutations
- `src/popup/App.tsx`: capture flow for the current tab
- `src/sidepanel/App.tsx`: queue management UI
- `src/shared/*`: types, storage, selectors, date helpers

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
- Default shortcut for quick-save is `Alt/Option + Shift + Q`.
- Local mode stores data only in this browser profile.
- Sync mode uses Chrome's extension sync storage and may hit Chrome quota limits if the queue gets very large.

## Verification
After installing the unpacked extension:
- Open a normal web page, click the extension popup, and save it.
- Confirm the tab closes and appears in the side panel.
- Set a reminder, wait for the notification, then click it to reopen the page.
- Move items between `Today`, `This Week`, `Later`, and `Waiting`.
- Switch between `Local` and `Sync` storage modes from the side panel.
