# Tab Queue Privacy

Tab Queue stores saved tab data inside Chrome extension storage.

## Data the extension stores
- Tab title
- Tab URL
- Optional note
- Optional reminder time
- Lightweight completion history
- Extension settings

## Where data is stored
- `Local` mode uses Chrome local extension storage on the current device
- `Sync` mode uses Chrome sync extension storage through the user's Chrome account

## What Tab Queue does not do
- No external server
- No user account system
- No hidden analytics backend
- No default upload of page contents

## Notifications
If you set a reminder, the extension uses Chrome alarms and notifications to remind you to return to a saved tab.

## Control
Users can delete individual queue items, remove completed history items, or clear completed history from inside the extension.
