function matchingSuffix(left, right) {
  let count = 0;
  while (count < left.length && count < right.length
    && left[left.length - 1 - count] === right[right.length - 1 - count]) count += 1;
  return count;
}

function matchingPrefix(left, right) {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
}

export function relocateThreadAnchor(text, anchor = {}) {
  const source = String(text ?? "");
  const quote = String(anchor.quote ?? "");
  const originalStart = Number(anchor.start ?? anchor.originalStart ?? 0);
  const originalEnd = Number(anchor.end ?? anchor.originalEnd ?? originalStart + quote.length);
  if (quote && source.slice(originalStart, originalEnd) === quote) return { start: originalStart, end: originalEnd, quote, detached: false };
  if (!quote) return { start: null, end: null, quote, detached: true };
  const candidates = [];
  let index = source.indexOf(quote);
  while (index >= 0) {
    const before = source.slice(Math.max(0, index - 120), index);
    const after = source.slice(index + quote.length, index + quote.length + 120);
    const score = matchingSuffix(String(anchor.prefix ?? ""), before) * 4
      + matchingPrefix(String(anchor.suffix ?? ""), after) * 4
      - Math.min(Math.abs(index - originalStart), 10_000) / 10_000;
    candidates.push({ start: index, end: index + quote.length, quote, detached: false, score });
    index = source.indexOf(quote, index + 1);
  }
  if (!candidates.length) return { start: null, end: null, quote, detached: true };
  candidates.sort((left, right) => right.score - left.score || left.start - right.start);
  const { start, end, detached } = candidates[0];
  return { start, end, quote, detached };
}

export function threadsForField(threads = [], fieldKey = "", text = "") {
  return threads
    .filter((thread) => thread?.fieldKey === fieldKey)
    .map((thread) => ({ ...thread, anchor: relocateThreadAnchor(text, thread.anchor) }))
    .sort((left, right) => Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0));
}

export function annotatedSegments(text = "", threads = []) {
  const source = String(text ?? "");
  const active = threads.filter((thread) => !thread.anchor?.detached
    && Number.isInteger(thread.anchor?.start) && Number.isInteger(thread.anchor?.end)
    && thread.anchor.start >= 0 && thread.anchor.end > thread.anchor.start && thread.anchor.end <= source.length);
  const boundaries = new Set([0, source.length]);
  for (const thread of active) { boundaries.add(thread.anchor.start); boundaries.add(thread.anchor.end); }
  const points = [...boundaries].sort((left, right) => left - right);
  const segments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]; const end = points[index + 1];
    if (end <= start) continue;
    const threadRefs = active.filter((thread) => thread.anchor.start < end && thread.anchor.end > start).map((thread) => thread.threadRef);
    segments.push({ text: source.slice(start, end), start, end, threadRefs });
  }
  return segments;
}

export function selectionOffsets(root, selection = globalThis.getSelection?.()) {
  if (!root || !selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const before = range.cloneRange(); before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
  const selected = range.toString();
  if (!selected.trim()) return null;
  const start = before.toString().length;
  return { start, end: start + selected.length, quote: selected };
}
