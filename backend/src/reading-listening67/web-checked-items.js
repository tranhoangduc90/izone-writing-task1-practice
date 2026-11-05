// Only expose counts. Checkpoint evidence and target identifiers stay on the server.
export function checkedItems(totalIds, semanticIds, issues, isVerified) {
  if (!Array.isArray(totalIds)) return null;
  const all = new Set(totalIds);
  const semantic = new Set(semanticIds);
  if (!all.size || all.size !== totalIds.length || semantic.size !== semanticIds.length ||
      semanticIds.some(id => !all.has(id))) return null;

  const blocked = new Set(issues.map(issue => issue.targetId));
  const globalIssue = issues.some(issue => !issue.targetId);
  const reviewed = globalIssue ? 0 : semanticIds.filter(id => !blocked.has(id) && isVerified(id)).length;
  return { checkedItems: all.size - semantic.size + reviewed, totalItems: all.size };
}
