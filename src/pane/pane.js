(function () {
  if (window.__mimeTreePaneInitialized) {
    console.log('[MIME Tree Viewer/pane] already initialized in this document, skipping');
    return;
  }
  window.__mimeTreePaneInitialized = true;

  // Sizing: the default pane height fits ~4 sibling nodes plus a little
  // breathing room, so a typical small tree is fully visible and a larger
  // one gets a visible scrollbar rather than growing the pane indefinitely.
  const NODE_HEIGHT = 32; // keep in sync with .mime-node height in pane.css
  const NODE_GAP = 10; // keep in sync with .mime-children gap in pane.css
  const SCROLL_PADDING = 16; // keep in sync with .mime-tree-scroll padding
  const VISIBLE_ROWS = 4;
  const DEFAULT_HEIGHT =
    VISIBLE_ROWS * NODE_HEIGHT + (VISIBLE_ROWS - 1) * NODE_GAP + SCROLL_PADDING * 2 + 20;
  const MIN_HEIGHT = 80;
  const MAX_HEIGHT = 600;

  // How much extra scroll room to add at the end of the message body, on
  // top of the pane's own height, so the reader can still scroll far enough
  // to see the last of the message content without it being tucked under
  // the fixed pane.
  const SPACER_BUFFER = 40;

  // Header name patterns to omit from the ROOT part's tooltip only (the
  // full message-level headers) -- long, repetitive routing/auth trace
  // headers that are rarely what someone wants to inspect. Extend this
  // list freely; '*' matches any run of characters, matching is
  // case-insensitive, and each pattern matches a whole header name.
  const ROOT_HEADER_HIDE_PATTERNS = [
    'received',
    'dkim-*',
    'arc-*',
    'x-me-*',
    'x-ms-*',
  ];

  const ROOT_HEADER_HIDE_REGEXPS = ROOT_HEADER_HIDE_PATTERNS.map((pattern) => {
    const escaped = pattern
      .toLowerCase()
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  });

  function isHiddenRootHeader(key) {
    const lower = key.toLowerCase();
    return ROOT_HEADER_HIDE_REGEXPS.some((re) => re.test(lower));
  }

  let currentTree = null;
  let container, handle, body, scrollArea, canvas, svg, treeRoot, tooltip, bodySpacer;
  let partCount = 0;
  let maxDepth = 0;

  function debugLog(...args) {
    // Mirrors to this document's own console (reachable only via Browser
    // Toolbox) AND relays to the background page's console (reachable via
    // Debug Add-ons -> Inspect), since the message document itself has no
    // accessible inspector by default.
    console.log('[MIME Tree Viewer/pane]', ...args);
    browser.runtime.sendMessage({ type: 'MIME_TREE_DEBUG', args }).catch(() => {});
  }

  function init() {
    debugLog('pane init() running, document =', document.location.href);
    buildContainer();
    ensureBodySpacer();
    restoreState().then(requestTree);
  }

  async function requestTree() {
    debugLog('requesting tree...');
    try {
      const response = await browser.runtime.sendMessage({ type: 'MIME_TREE_REQUEST' });
      debugLog('got response:', response);
      currentTree = (response && response.tree) || null;
    } catch (e) {
      debugLog('request failed:', String(e));
      currentTree = null;
    }
    renderTree();
  }

  function buildContainer() {
    container = document.createElement('div');
    container.className = 'mime-tree-container';

    handle = document.createElement('div');
    handle.className = 'mime-tree-handle';
    handle.textContent = 'MIME tree';
    handle.addEventListener('click', toggleCollapsed);
    container.appendChild(handle);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'mime-tree-resize-handle';
    resizeHandle.addEventListener('mousedown', startResize);
    container.appendChild(resizeHandle);

    body = document.createElement('div');
    body.className = 'mime-tree-body';
    scrollArea = document.createElement('div');
    scrollArea.className = 'mime-tree-scroll';

    // canvas wraps both the SVG connector overlay and the actual chip tree,
    // in the same coordinate space, so connector geometry never has to be
    // reconciled across separately-styled elements.
    canvas = document.createElement('div');
    canvas.className = 'mime-tree-canvas';

    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'mime-tree-svg');
    canvas.appendChild(svg);

    treeRoot = document.createElement('div');
    treeRoot.className = 'mime-tree-root';
    canvas.appendChild(treeRoot);

    scrollArea.appendChild(canvas);
    body.appendChild(scrollArea);
    container.appendChild(body);

    tooltip = document.createElement('div');
    tooltip.className = 'mime-tree-tooltip';
    tooltip.hidden = true;
    container.appendChild(tooltip);

    document.documentElement.appendChild(container);
    window.addEventListener('resize', debounce(drawConnectors, 150));
  }

  // ---- scroll-room spacer in the message body itself ----
  //
  // The pane is fixed over the bottom of the viewport, so without this,
  // scrolling a message to its natural end would leave the last bit of
  // content hidden behind the pane. This appends blank space to the
  // message's own body, sized to the pane's current on-screen height plus
  // a small buffer, so the message can always be scrolled clear of it.

  function ensureBodySpacer() {
    if (!document.body) return;
    bodySpacer = document.createElement('div');
    bodySpacer.className = 'mime-tree-body-spacer';
    document.body.appendChild(bodySpacer);
    updateBodySpacer();
  }

  function updateBodySpacer() {
    if (!bodySpacer) return;
    const paneHeight = container.getBoundingClientRect().height;
    bodySpacer.style.height = `${paneHeight + SPACER_BUFFER}px`;
  }

  // ---- persisted UI state (routed through the background script) ----

  async function restoreState() {
    let stored = {};
    try {
      stored = (await browser.runtime.sendMessage({ type: 'MIME_TREE_GET_STATE' })) || {};
    } catch (e) {
      // background not reachable yet / no stored state -- fall back to defaults
    }
    const collapsed = stored['mimeTreePane.collapsed'] ?? false;
    const height = stored['mimeTreePane.height'] ?? DEFAULT_HEIGHT;
    container.classList.toggle('collapsed', collapsed);
    body.style.height = `${height}px`;
    updateHandleLabel();
    updateBodySpacer();
  }

  function persistState(partial) {
    browser.runtime.sendMessage({ type: 'MIME_TREE_SET_STATE', state: partial }).catch(() => {});
  }

  function toggleCollapsed() {
    const collapsed = !container.classList.contains('collapsed');
    container.classList.toggle('collapsed', collapsed);
    updateHandleLabel();
    updateBodySpacer();
    persistState({ 'mimeTreePane.collapsed': collapsed });
  }

  // ---- manual resize (drag the strip above the pane) ----

  let resizeStartY = 0;
  let resizeStartHeight = 0;

  function startResize(e) {
    resizeStartY = e.clientY;
    resizeStartHeight = body.getBoundingClientRect().height;
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', stopResize);
    e.preventDefault();
  }

  function onResizeMove(e) {
    const delta = resizeStartY - e.clientY; // dragging up grows the pane
    const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, resizeStartHeight + delta));
    body.style.height = `${newHeight}px`;
    updateBodySpacer();
    drawConnectors();
  }

  function stopResize() {
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', stopResize);
    updateBodySpacer();
    persistState({ 'mimeTreePane.height': body.getBoundingClientRect().height });
  }

  // ---- rendering ----

  function renderTree() {
    treeRoot.innerHTML = '';
    if (!currentTree) {
      svg.innerHTML = '';
      return;
    }

    const stats = MimeBfs.countAndDepth(currentTree);
    partCount = stats.count;
    maxDepth = stats.depth;

    treeRoot.appendChild(buildRow(currentTree));
    updateHandleLabel();
    requestAnimationFrame(drawConnectors);
  }

  function updateHandleLabel() {
    const arrow = container.classList.contains('collapsed') ? '\u25B8' : '\u25BE';
    const summary = partCount
      ? `${partCount} part${partCount === 1 ? '' : 's'}, depth ${maxDepth}`
      : 'no message loaded';
    handle.textContent = `${arrow} MIME tree \u2014 ${summary}`;
  }

  function buildRow(node) {
    const row = document.createElement('div');
    row.className = 'mime-row';

    const chip = buildChip(node);
    const kids = node.children || [];

    if (kids.length) {
      chip.classList.add('mime-has-children');
      const col = document.createElement('div');
      col.className = 'mime-children';

      for (const child of kids) {
        col.appendChild(child.isGroup ? buildGroupChip(child) : buildRow(child));
      }

      row.appendChild(chip);
      row.appendChild(col);
    } else {
      row.appendChild(chip);
    }

    return row;
  }

  function buildChip(node) {
    const chip = document.createElement('div');
    const cls = MimeColors.classify(node.contentType, node.headers);
    let className = `mime-node mime-${cls.family}`;
    if (cls.shade) className += ` mime-shade-${cls.shade}`;
    if (node.isRoot) className += ' mime-bold-border';
    chip.className = className;
    chip.dataset.bfs = String(node.bfsIndex);

    const badge = document.createElement('span');
    badge.className = 'mime-badge';
    badge.textContent = `(${node.bfsIndex})`;
    chip.appendChild(badge);

    const label = document.createElement('span');
    label.className = 'mime-label';
    label.textContent = MimeColors.shortLabel(node.contentType);
    chip.appendChild(label);

    chip.addEventListener('mouseenter', (e) => showTooltip(e, node));
    chip.addEventListener('mousemove', moveTooltip);
    chip.addEventListener('mouseleave', hideTooltip);

    return chip;
  }

  function buildGroupChip(group) {
    const chip = document.createElement('div');
    chip.className = 'mime-node mime-group-chip';
    chip.textContent = `+${group.count} \u00d7 ${MimeColors.shortLabel(group.contentType)}`;
    chip.title = 'Click to expand';
    chip.addEventListener('click', () => {
      const rows = group.items.map(buildRow);
      chip.replaceWith(...rows);
      drawConnectors();
    });
    return chip;
  }

  // ---- connectors: one SVG overlay per tree, all geometry computed from ----
  // ---- actual rendered chip positions in a single shared coordinate space --
  //
  // Shape per parent, exactly "horizontal out of parent, vertical trunk
  // spanning the children, horizontal into each child":
  //
  //   parent |----+
  //                |----- child 1
  //                |----- child 2
  //                |----- child 3
  //
  // Re-derived by walking the live DOM each time (rather than maintaining a
  // hand-tracked list) so it stays correct after group-chip expansion, which
  // mutates the tree in place.

  const TRUNK_GAP = 12; // px out from the parent chip's right edge

  function collectLinks() {
    const links = [];
    treeRoot.querySelectorAll('.mime-node.mime-has-children').forEach((chip) => {
      const row = chip.parentElement;
      const col = row && row.querySelector(':scope > .mime-children');
      if (!col) return;
      links.push({ parentChip: chip, childEls: Array.from(col.children) });
    });
    return links;
  }

  function anchorOf(el) {
    // A child slot is either a .mime-row (whose own first child is its
    // chip) or a bare .mime-node.mime-group-chip (already the anchor).
    return el.classList.contains('mime-row') ? el.firstElementChild : el;
  }

  function drawConnectors() {
    const canvasRect = canvas.getBoundingClientRect();
    const links = collectLinks();
    const segments = [];

    for (const { parentChip, childEls } of links) {
      const pRect = parentChip.getBoundingClientRect();
      const startX = pRect.right - canvasRect.left;
      const startY = pRect.top + pRect.height / 2 - canvasRect.top;

      const childPoints = childEls.map((el) => {
        const r = anchorOf(el).getBoundingClientRect();
        return {
          x: r.left - canvasRect.left,
          y: r.top + r.height / 2 - canvasRect.top,
        };
      });
      if (!childPoints.length) continue;

      const trunkX = startX + TRUNK_GAP;
      const ys = childPoints.map((p) => p.y).concat(startY);
      const trunkTop = Math.min(...ys);
      const trunkBottom = Math.max(...ys);

      segments.push(`M ${startX} ${startY} H ${trunkX}`); // out of parent
      if (trunkBottom - trunkTop > 0.5) {
        segments.push(`M ${trunkX} ${trunkTop} V ${trunkBottom}`); // trunk
      }
      for (const pt of childPoints) {
        segments.push(`M ${trunkX} ${pt.y} H ${pt.x}`); // into each child
      }
    }

    svg.setAttribute('width', canvas.scrollWidth);
    svg.setAttribute('height', canvas.scrollHeight);
    svg.innerHTML = segments.length
      ? `<path class="mime-connector-path" d="${segments.join(' ')}" />`
      : '';
  }

  // ---- tooltip ----

  function showTooltip(e, node) {
    tooltip.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'mime-tooltip-title';
    title.textContent = node.name ? `${node.contentType} \u2014 ${node.name}` : node.contentType;
    tooltip.appendChild(title);

    if (typeof node.size === 'number') {
      const size = document.createElement('div');
      size.className = 'mime-tooltip-size';
      size.textContent = formatSize(node.size);
      tooltip.appendChild(size);
    }

    tooltip.appendChild(buildHeaderList(node.headers, node.isRoot));

    tooltip.hidden = false;
    moveTooltip(e);
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  function moveTooltip(e) {
    const margin = 14;
    tooltip.style.left = '0px';
    tooltip.style.top = '0px';
    const rect = tooltip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = e.clientX + margin;
    let y = e.clientY + margin;
    if (x + rect.width > vw - margin) x = e.clientX - rect.width - margin;
    if (y + rect.height > vh - margin) y = e.clientY - rect.height - margin;
    tooltip.style.left = `${Math.max(margin, x)}px`;
    tooltip.style.top = `${Math.max(margin, y)}px`;
  }

  function buildHeaderList(headers, isRoot) {
    const container = document.createElement('div');
    container.className = 'mime-tooltip-headers';

    const allEntries = Object.entries(headers || {});
    const entries = isRoot
      ? allEntries.filter(([key]) => !isHiddenRootHeader(key))
      : allEntries;
    const hiddenCount = allEntries.length - entries.length;

    if (!entries.length) {
      container.textContent = hiddenCount
        ? `(${hiddenCount} routing/auth header${hiddenCount === 1 ? '' : 's'} hidden)`
        : '(no headers on this part)';
      return container;
    }

    for (const [key, values] of entries) {
      for (const rawValue of values) {
        const line = document.createElement('div');
        line.className = 'mime-tooltip-header-line';

        const nameEl = document.createElement('span');
        nameEl.className = 'mime-tooltip-header-name';
        nameEl.textContent = key;

        const valueEl = document.createElement('span');
        valueEl.className = 'mime-tooltip-header-value';
        valueEl.textContent = ' ' + unfoldHeaderValue(rawValue);

        line.appendChild(nameEl);
        line.appendChild(document.createTextNode(':'));
        line.appendChild(valueEl);
        container.appendChild(line);
      }
    }

    if (hiddenCount) {
      const note = document.createElement('div');
      note.className = 'mime-tooltip-hidden-note';
      note.textContent = `+ ${hiddenCount} routing/auth header${hiddenCount === 1 ? '' : 's'} hidden`;
      container.appendChild(note);
    }

    return container;
  }

  // RFC 5322 header folding embeds a newline plus leading whitespace as a
  // purely visual continuation marker; collapse any run of whitespace
  // (newlines, tabs, repeated spaces from the original indentation) down to
  // a single space so the value reads and wraps as one logical line.
  function unfoldHeaderValue(value) {
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  init();
})();
