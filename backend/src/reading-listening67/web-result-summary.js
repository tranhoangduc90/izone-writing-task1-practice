// Nhận kết quả đã lưu; chỉ đếm đủ 20 mục hợp lệ, không suy điểm từ phần đã điền.
// Thiếu/mâu thuẫn trả null để UI và Docs không thông báo đạt toàn bộ sai.
export function reading67ResultSummary(result) {
  if(result?.grading?.kind==='matching_headings')return reading67HeadingsSummary(result.grading);
  const rows = result?.grading?.target_results;
  if (!Array.isArray(rows) || rows.length !== 20 ||
      rows.some(r => typeof r.target_id !== 'string' || !['correct','partial','incorrect','missing'].includes(r.verdict)) ||
      new Set(rows.map(r => r.target_id)).size !== 20) return null;
  const matching = rows.filter(r => r.target_id.endsWith('.section'));
  if (matching.length !== 4) return null;
  const compression = rows.filter(r => !r.target_id.endsWith('.section'));
  const needsRepair = rows.filter(r => r.verdict !== 'correct').map(r => r.target_id);
  return {version:1, matchingCorrect:matching.filter(r => r.verdict === 'correct').length,
    matchingTotal:matching.length, compressionCorrect:compression.filter(r => r.verdict === 'correct').length,
    compressionTotal:compression.length, total:rows.length, correctCount:rows.length-needsRepair.length,
    remainingCount:needsRepair.length, needsRepair, allCorrect:needsRepair.length===0};
}

export function reading67HeadingsSummary(grading){
 const rows=grading.target_results,ids=grading.structure?.targetIds,headings=grading.structure?.headingIds;
 if(!Array.isArray(rows)||!Array.isArray(ids)||!Array.isArray(headings)||ids.length!==15||headings.length!==5||new Set(ids).size!==ids.length||rows.length!==ids.length||new Set(rows.map(r=>r.target_id)).size!==ids.length||headings.some(id=>!ids.includes(id))||rows.some(r=>!ids.includes(r.target_id)||!['correct','partial','incorrect','missing'].includes(r.verdict)))return null;
 const matching=rows.filter(r=>headings.includes(r.target_id)),compression=rows.filter(r=>!headings.includes(r.target_id)),needsRepair=rows.filter(r=>r.verdict!=='correct').map(r=>r.target_id);
 return {version:1,kind:'matching_headings',matchingCorrect:matching.filter(r=>r.verdict==='correct').length,matchingTotal:5,compressionCorrect:compression.filter(r=>r.verdict==='correct').length,compressionTotal:10,total:15,correctCount:15-needsRepair.length,remainingCount:needsRepair.length,needsRepair,allCorrect:needsRepair.length===0};
}

export function reading67ProgressText(progress) {
  if (!progress) return '';
  return ` Kết quả: đúng ${progress.matchingCorrect}/${progress.matchingTotal} câu. Phần nén: ${progress.compressionCorrect}/${progress.compressionTotal} phần đạt.` +
    (progress.allCorrect ? ' Đã sửa đúng toàn bộ bài.' : ` Còn ${progress.remainingCount} phần cần sửa.`);
}
