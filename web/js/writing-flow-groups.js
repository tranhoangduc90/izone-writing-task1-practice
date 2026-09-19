// Nhận vào: các cặp bài API trả về, có mã lớp, hồ sơ và file homework.
// Việc chính: gom theo lớp → hồ sơ homework → từng link file, giữ đúng thứ tự API.
// Trả ra: nhóm để màn hình vẽ mà không làm mất hoặc ghép nhầm một cặp bài.
// Khi thiếu định danh: giữ cặp trong nhóm “chưa rõ” để người vận hành vẫn nhìn thấy.
export function groupWritingPairs(pairs) {
  const classes = new Map();
  for (const [position, pair] of pairs.entries()) {
    const classCode = pair.class_code || 'Chưa rõ lớp';
    if (!classes.has(classCode)) classes.set(classCode, { classCode, homeworks: [], index: new Map() });
    const classGroup = classes.get(classCode);
    const homeworkKey = pair.source_app_id && pair.source_table_id && pair.source_record_id
      ? JSON.stringify([pair.source_app_id, pair.source_table_id, pair.source_record_id])
      : `chưa rõ hồ sơ ${position}`;
    if (!classGroup.index.has(homeworkKey)) {
      const homework = { recordId: pair.source_record_id || 'Chưa rõ hồ sơ',
        files: [], index: new Map() };
      classGroup.index.set(homeworkKey, homework);
      classGroup.homeworks.push(homework);
    }
    const homework = classGroup.index.get(homeworkKey);
    const fileKey = pair.homework_file_id && pair.source_link_index != null
      ? JSON.stringify([pair.homework_file_id, pair.source_link_index])
      : `chưa rõ file ${position}`;
    if (!homework.index.has(fileKey)) {
      const file = { docId: pair.homework_file_id || null,
        linkIndex: pair.source_link_index ?? null, pairs: [] };
      homework.index.set(fileKey, file);
      homework.files.push(file);
    }
    homework.index.get(fileKey).pairs.push(pair);
  }
  return [...classes.values()].map(({ classCode, homeworks }) => ({
    classCode, homeworks: homeworks.map(({ recordId, files }) => ({
      recordId, files,
    })),
  }));
}
