# MIME Tree Viewer

A Thunderbird MailExtension (Manifest V3) that shows a collapsible,
color-coded MIME structure tree fixed to the bottom of the message view:
root on the left, branches growing right, breadth-first numbered nodes,
and a hover tooltip with the part's full headers.

No Experiment APIs are used anywhere -- everything is standard,
documented WebExtension API surface.

## Repo layout

```
.
├── build.sh        -- packages src/ into dist/mime-tree-viewer-<version>.xpi
├── src/            -- the actual extension source (this is what gets zipped)
│   ├── manifest.json
│   ├── background.js
│   ├── mime/
│   │   ├── colors.js   -- content-type -> color family/shade + short labels
│   │   └── bfs.js       -- BFS numbering, sibling grouping, tree stats
│   └── pane/
│       ├── pane.js      -- injected into the message document; builds the UI
│       └── pane.css
└── dist/           -- build output (git-ignored), created by build.sh
```

## Building the .xpi

```
./build.sh
```

This reads the version out of `src/manifest.json` and writes
`dist/mime-tree-viewer-<version>.xpi`. Requires `bash` and `zip` (both
present by default on Linux/macOS; on Windows, run from WSL or Git Bash
with `zip` installed).

## Installing

**Permanent install (from the built .xpi):**
Thunderbird → Settings → Add-ons and Themes (or `Tools → Add-ons and
Themes`) → gear icon → "Install Add-on From File..." → select the `.xpi`
from `dist/`.

**Temporary install (for development -- reloads are needed after every
change, and it's removed when Thunderbird restarts):**
`Tools → Developer Tools → Debug Add-ons` → "Load Temporary Add-on..." →
select `src/manifest.json` directly (no need to build an .xpi for this).

## Debugging

The message document that `pane/pane.js` runs inside has no accessible
right-click "Inspect" by default. Two ways around that:

1. **Console relay (already built in):** `pane.js` mirrors its debug logs
   to the background page's console via `runtime.sendMessage`. Reach that
   console via the Debug Add-ons page → the "Inspect" link next to this
   extension's entry.
2. **Browser Toolbox (for direct inspection of the message document):**
   set `devtools.chrome.enabled` and `devtools.debugger.remote-enabled` to
   `true` in `about:config`, restart, then use
   `Tools → Developer Tools → Browser Toolbox`.

## Architecture notes

- `scripting.messageDisplay.registerScripts()` (MV3) injects `pane.js` +
  `pane.css` into every message's rendered document. There is no
  manifest key for this in MV3 -- it must be registered from the
  background script, which `background.js` does on every startup
  (un-registering first, so re-running it is idempotent).
- The pane *pulls* its own data (`MIME_TREE_REQUEST` → background looks up
  `messageDisplay.getDisplayedMessages(tabId)` → `messages.getFull()` →
  `MimeBfs.buildAnnotatedTree()`) rather than the background pushing data
  into the document, since event-page wake timing makes push delivery
  unreliable.
- The pane is `position: fixed` inside the message document (not a
  separate docked chrome panel), which needs no Experiment API and still
  stays visible while the message scrolls.
- Connector lines are a single SVG overlay per tree, all geometry computed
  from actual rendered chip positions in one shared coordinate space
  (parent → trunk → each child), rather than several separately-styled
  CSS pieces that would need to agree pixel-for-pixel.

## Changelog

- **0.1.5** -- Default pane height now sized to ~4 sibling nodes plus a
  little breathing room. A spacer is appended to the message body so the
  message can still be scrolled clear of the fixed pane. Root-only header
  tooltip filtering via an editable pattern list (`Received`, `DKIM-*`,
  `ARC-*`, `X-ME-*`, `X-MS-*` by default). Tooltip header list switched
  from a monospace/column-aligned block to italic-name / upright-value
  lines, with RFC 5322 header folding unfolded to one wrapped line.
  Connector lines redrawn as a single SVG overlay per tree.
- **0.1.4** -- Fixed `messageDisplay.getDisplayedMessages()` returning a
  `MessageList` (`{ id, messages }`), not a plain array as older docs
  describe; code was checking `.length` on the wrong thing.
- **0.1.3** -- Added console-relay debug logging (pane → background)
  since the message document has no accessible inspector by default.
- **0.1.2** -- Switched the background → pane data flow from push
  (`tabs.sendMessage` racing against the pane script's load/listener-attach
  time) to pull (pane requests its own tree once it has initialized).
- **0.1.1** -- Fixed two MV3-specific bugs from the first draft:
  `messageDisplay.onMessageDisplayed` doesn't exist in MV3 (replaced with
  `onMessagesDisplayed`), and there is no `message_display_scripts`
  manifest key in MV3 (the pane script must be registered programmatically
  via `scripting.messageDisplay.registerScripts()`).
- **0.1.0** -- Initial draft.
