export function atomicIssuesCoverRevision(original, revised, issues) {
  // Nhận vào: câu gốc, câu sửa và từng lý do AI tạo ở bước chấm.
  // Việc chính: thay lần lượt đúng các cụm mà issue khai báo; phần chữ còn lại phải giống hệt.
  // Trả ra: true khi mọi thay đổi đều có một issue riêng; false sẽ chuyển sang phân xử.
  if (!Array.isArray(issues) || !issues.length) return false;
  let originalAt = 0;
  let revisedAt = 0;
  const groupsSeveralEdits = (before, after) => {
    const left = before.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) || [];
    const right = after.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) || [];
    for (let i = 1; i < left.length - 3; i += 1) {
      for (let j = 1; j < right.length - 3; j += 1) {
        if (left.slice(i, i + 3).join(' ') === right.slice(j, j + 3).join(' ')) {
          return true;
        }
      }
    }
    return false;
  };
  for (const issue of issues) {
    const before = String(issue?.span ?? '');
    const after = String(issue?.revised_span ?? '');
    if (!before || !after || before === after || !String(issue?.reason ?? '').trim()) return false;
    let foundAt = original.indexOf(before, originalAt);
    while (foundAt >= 0 && !revised.startsWith(original.slice(originalAt, foundAt) + after, revisedAt)) {
      foundAt = original.indexOf(before, foundAt + 1);
    }
    if (foundAt < 0) return false;
    const unchanged = original.slice(originalAt, foundAt);
    if (before.length > original.length * 0.55 && original.length >= 35) return false;
    if (after.length > revised.length * 0.55 && revised.length >= 35) return false;
    if (groupsSeveralEdits(before, after)) return false;
    originalAt = foundAt + before.length;
    revisedAt += unchanged.length + after.length;
  }
  return original.slice(originalAt) === revised.slice(revisedAt);
}

// Split only edits already declared by the model, retaining its exact rationale.
// Unknown coverage, empty fragments or excessive diff size stay rejected.
export function splitDeclaredAtomicIssues(original, revised, issues) {
  if (atomicIssuesCoverRevision(original, revised, issues)) return issues;
  const result = [];
  let sourceAt = 0, revisedAt = 0;
  for (const issue of issues) {
    const before = String(issue.span ?? ''), after = String(issue.revised_span ?? '');
    if (!before || !after || !String(issue.reason ?? '').trim()) return issues;
    let at = original.indexOf(before, sourceAt);
    while (at >= 0 && !revised.startsWith(original.slice(sourceAt, at) + after, revisedAt)) {
      at = original.indexOf(before, at + 1);
    }
    if (at < 0) return issues;
    const left = before.match(/\S+\s*/gu) || [], right = after.match(/\S+\s*/gu) || [];
    if (left.length * right.length > 40000) return issues;
    const dp = Array.from({length:left.length + 1}, () => new Uint16Array(right.length + 1));
    for (let i=left.length-1;i>=0;i--) for (let j=right.length-1;j>=0;j--) {
      dp[i][j] = left[i] === right[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j],dp[i][j+1]);
    }
    let i=0,j=0;
    while (i<left.length || j<right.length) {
      if (i<left.length && j<right.length && left[i]===right[j]) {i++;j++;continue;}
      const startI=i,startJ=j;
      while (i<left.length || j<right.length) {
        if (i<left.length && j<right.length && left[i]===right[j]) break;
        if (j<right.length && (i===left.length || dp[i][j+1]>=dp[i+1][j])) j++;
        else i++;
      }
      let span=left.slice(startI,i).join(''), replacement=right.slice(startJ,j).join('');
      while (/\s$/u.test(span) && span.at(-1)===replacement.at(-1)) {span=span.slice(0,-1);replacement=replacement.slice(0,-1);}
      if (!span || !replacement || span===replacement) return issues;
      result.push({...issue,span,revised_span:replacement});
    }
    revisedAt += original.slice(sourceAt,at).length + after.length;
    sourceAt = at + before.length;
  }
  if (original.slice(sourceAt)!==revised.slice(revisedAt)) return issues;
  return atomicIssuesCoverRevision(original,revised,result) ? result : issues;
}
