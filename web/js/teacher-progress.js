export function compareVietnameseNames(left, right) {
  return String(left.displayName || '').localeCompare(String(right.displayName || ''), 'vi', { sensitivity: 'base' });
}

function supportStats(student) {
  const sections = Array.isArray(student.supportSections) ? student.supportSections : [];
  return {
    count: sections.length,
    milestone: Math.max(0, ...sections.map(item => Number(item.commentNumber) || 0)),
    oldest: Math.min(Number.MAX_SAFE_INTEGER, ...sections.map(item => Date.parse(item.warningAt) || Number.MAX_SAFE_INTEGER))
  };
}

export function compareStudents(left, right) {
  const leftGroup = left.supportRequired ? 0 : left.hasStarted ? 1 : 2;
  const rightGroup = right.supportRequired ? 0 : right.hasStarted ? 1 : 2;
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;
  if (leftGroup === 0) {
    const a = supportStats(left); const b = supportStats(right);
    return b.count - a.count || b.milestone - a.milestone || a.oldest - b.oldest || compareVietnameseNames(left, right);
  }
  if (leftGroup === 1) return (left.progressPercent || 0) - (right.progressPercent || 0)
    || (left.passedSectionCount || 0) - (right.passedSectionCount || 0)
    || (left.attemptedSectionCount || 0) - (right.attemptedSectionCount || 0)
    || compareVietnameseNames(left, right);
  return compareVietnameseNames(left, right);
}

export function groupStudents(students) {
  const sorted = [...students].sort(compareStudents);
  return [
    { key: 'support', title: 'Cần hỗ trợ ngay', students: sorted.filter(item => item.supportRequired) },
    { key: 'started', title: 'Đang làm', students: sorted.filter(item => !item.supportRequired && item.hasStarted) },
    { key: 'not_started', title: 'Chưa bắt đầu', students: sorted.filter(item => !item.supportRequired && !item.hasStarted) }
  ];
}
