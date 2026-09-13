// Shared tree-walking helpers: turns the raw MessagePart tree returned by
// messages.getFull() into a small, serializable, annotated tree with
// breadth-first numbering and repeated-sibling grouping baked in.
//
// Loaded as a plain script in both the background context (to build the
// tree) and the pane context (to read stats off it), so no ES modules.

var MimeBfs = (function () {
  function collectHeaders(part) {
    const out = {};
    const headers = part.headers || {};
    for (const key of Object.keys(headers)) {
      const val = headers[key];
      out[key.toLowerCase()] = Array.isArray(val)
        ? val.map(String)
        : [String(val)];
    }
    return out;
  }

  // Pass 1 (breadth-first) assigns 0..N-1 over the *original* part objects.
  // Pass 2 (depth-first) builds the serializable annotated tree, looking up
  // each part's precomputed number, and groups long runs of identical
  // siblings (e.g. a pile of image attachments) into a single collapsible
  // summary entry.
  function buildAnnotatedTree(rootPart, groupThreshold) {
    groupThreshold = groupThreshold || 4;

    const numbering = new Map();
    const queue = [rootPart];
    let counter = 0;
    while (queue.length) {
      const node = queue.shift();
      numbering.set(node, counter++);
      const kids = node.parts || [];
      for (const k of kids) queue.push(k);
    }

    function annotate(part, isRoot) {
      const children = (part.parts || []).map((p) => annotate(p, false));
      return {
        bfsIndex: numbering.get(part),
        contentType: part.contentType || "application/octet-stream",
        name: part.name || null,
        size: typeof part.size === "number" ? part.size : null,
        headers: collectHeaders(part),
        // Only kept for special-cased parts (e.g. text/x-moz-deleted, whose
        // body text names the original attachment's headers) -- not used
        // for display of ordinary parts, so no size/privacy concern beyond
        // what getFull() already exposed to this extension.
        body: typeof part.body === "string" ? part.body : null,
        isRoot: !!isRoot,
        children: groupRepeatedSiblings(children, groupThreshold),
      };
    }

    return annotate(rootPart, true);
  }

  function groupRepeatedSiblings(children, threshold) {
    const result = [];
    let i = 0;
    while (i < children.length) {
      let j = i;
      while (
        j < children.length &&
        children[j].contentType === children[i].contentType
      ) {
        j++;
      }
      const runLength = j - i;
      if (runLength >= threshold) {
        result.push({
          isGroup: true,
          contentType: children[i].contentType,
          count: runLength,
          items: children.slice(i, j),
        });
      } else {
        for (let k = i; k < j; k++) result.push(children[k]);
      }
      i = j;
    }
    return result;
  }

  function flattenChildren(children) {
    const out = [];
    for (const c of children) {
      if (c.isGroup) out.push(...c.items);
      else out.push(c);
    }
    return out;
  }

  function countAndDepth(node) {
    let count = 1;
    let depth = 1;
    for (const child of flattenChildren(node.children)) {
      const r = countAndDepth(child);
      count += r.count;
      depth = Math.max(depth, 1 + r.depth);
    }
    return { count, depth };
  }

  return { buildAnnotatedTree, countAndDepth, flattenChildren };
})();
