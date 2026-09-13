// MV3 replaced messageDisplayScripts (manifest-registered or .register()-
// registered) with scripting.messageDisplay, which must be registered
// programmatically -- there is no manifest key for it. We unregister any
// stale registration first so re-running this on every background restart
// is idempotent rather than erroring on a duplicate id.
const PANE_SCRIPT_ID = 'mime-tree-pane';

async function ensurePaneScriptRegistered() {
  try {
    await messenger.scripting.messageDisplay.unregisterScripts({ ids: [PANE_SCRIPT_ID] });
  } catch (e) {
    // Nothing registered yet -- fine.
  }
  try {
    await messenger.scripting.messageDisplay.registerScripts([
      {
        id: PANE_SCRIPT_ID,
        js: ['mime/colors.js', 'mime/bfs.js', 'pane/pane.js'],
        css: ['pane/pane.css'],
        runAt: 'document_idle',
      },
    ]);
  } catch (err) {
    console.error('MIME Tree Viewer: failed to register the pane script', err);
  }
}

// Deliberately a *pull* model: the pane script (running inside a specific
// message's document) asks "what's the MIME tree for the message I'm
// currently showing?" once it has finished initializing, rather than the
// background trying to guess/race when to push data into a document whose
// load timing it doesn't control. sender.tab.id identifies which tab (and
// therefore which currently displayed message) is asking.
async function buildTreeForTab(tabId) {
  const displayed = await messenger.messageDisplay.getDisplayedMessages(tabId);
  const messages = (displayed && displayed.messages) || [];
  debugLog('getDisplayedMessages(', tabId, ') -> messages.length =', messages.length);
  if (!messages.length) return null;
  const full = await messenger.messages.getFull(messages[0].id, { decodeHeaders: true });
  return MimeBfs.buildAnnotatedTree(full);
}

// Relays console messages from the pane script (which runs inside the
// message document and has no visible console via the normal UI) into
// this background page's console, which IS reachable via
// Tools -> Developer Tools -> Debug Add-ons -> Inspect.
function debugLog(...args) {
  console.log('[MIME Tree Viewer]', ...args);
}

function handleRuntimeMessage(msg, sender) {
  if (!msg) return undefined;

  if (msg.type === 'MIME_TREE_DEBUG') {
    debugLog('(pane)', ...(msg.args || []));
    return undefined;
  }

  if (msg.type === 'MIME_TREE_REQUEST') {
    let tabId = sender && sender.tab && sender.tab.id;
    debugLog('MIME_TREE_REQUEST from sender.tab.id =', tabId);
    const resolveTab = typeof tabId === 'number'
      ? Promise.resolve(tabId)
      : messenger.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
          const fallback = tabs && tabs[0] && tabs[0].id;
          debugLog('sender.tab missing, falling back to active tab id =', fallback);
          return fallback;
        });

    return resolveTab.then((resolvedTabId) => {
      if (typeof resolvedTabId !== 'number') {
        debugLog('no usable tab id, returning null tree');
        return { tree: null };
      }
      return buildTreeForTab(resolvedTabId)
        .then((tree) => {
          debugLog('built tree:', tree ? `root=${tree.contentType}, parts=${JSON.stringify(tree).length}b` : 'null');
          return { tree };
        })
        .catch((err) => {
          console.error('MIME Tree Viewer: failed to build tree for tab', resolvedTabId, err);
          return { tree: null };
        });
    });
  }

  if (msg.type === 'MIME_TREE_GET_STATE') {
    return messenger.storage.local.get(['mimeTreePane.collapsed', 'mimeTreePane.height']);
  }

  if (msg.type === 'MIME_TREE_SET_STATE') {
    return messenger.storage.local.set(msg.state || {});
  }

  return undefined;
}

messenger.runtime.onMessage.addListener(handleRuntimeMessage);
ensurePaneScriptRegistered();
