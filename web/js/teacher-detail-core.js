// Dữ liệu nhận vào: Comment, artifacts từ vựng và tọa độ nhấp chuột trong dashboard.
// Việc chính: lọc timeline theo section, lấy bảng từ vựng mới nhất và nhận biết cú nhấp ngoài popup.
// Kết quả: giao diện giảng viên hiển thị cùng dữ liệu với học viên và đóng popup đúng vùng tối.
// Khi lỗi: trả mảng rỗng hoặc giữ popup mở; không sửa bài làm hay dữ liệu học viên.
export function commentsForSection(comments = [], sectionKey = "") {
  return comments
    .filter((comment) => comment?.section === sectionKey)
    .slice()
    .sort((left, right) => {
      const byNumber = Number(right.commentNumber || 0) - Number(left.commentNumber || 0);
      if (byNumber) return byNumber;
      return Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0);
    });
}

export function normalizeVocabularyRows(value, bodyKey) {
  const hasBodyGroups = value && typeof value === "object" && !Array.isArray(value)
    && (Object.hasOwn(value, "body1") || Object.hasOwn(value, "body2"));
  const raw = hasBodyGroups ? value?.[bodyKey] : value;
  if (Array.isArray(raw)) {
    return raw
      .map((row) => ({
        idea: row?.idea || row?.meaning || row?.label || "",
        terms: row?.terms || row?.english || row?.words || "",
      }))
      .filter((row) => row.idea || row.terms);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([idea, terms]) => ({
      idea,
      terms: Array.isArray(terms) ? terms.join(", ") : String(terms || ""),
    }));
  }
  return [];
}

export function latestVocabularyRows(comments = [], bodyKey = "") {
  const newestFirst = comments.slice().sort((left, right) => {
    const byTime = Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0);
    return byTime || Number(right.commentNumber || 0) - Number(left.commentNumber || 0);
  });
  for (const comment of newestFirst) {
    const artifacts = comment?.artifacts || {};
    const rows = normalizeVocabularyRows(artifacts.vocabulary || artifacts.vocabularyRows, bodyKey);
    if (rows.length) return rows;
  }
  return [];
}

export function isBackdropClick(event, rect) {
  if (!event || !rect) return false;
  return event.clientX < rect.left || event.clientX > rect.right
    || event.clientY < rect.top || event.clientY > rect.bottom;
}
