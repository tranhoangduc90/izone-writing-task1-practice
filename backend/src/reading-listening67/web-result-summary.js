// Nhận kết quả đã lưu; chỉ đếm đủ 20 mục hợp lệ, không suy điểm từ phần đã điền.
// Thiếu/mâu thuẫn trả null để UI và Docs không thông báo đạt toàn bộ sai.
export function reading67ResultSummary(result) {
  if(result?.grading?.kind==='matching_people')return peopleSummary(result.grading);
  if(result?.grading?.kind==='matching_headings')return reading67HeadingsSummary(result.grading);
  if(result?.grading?.kind==='green-roofs')return greenRoofsSummary(result.grading);
  if(result?.grading?.kind==='tfng')return tfngSummary(result.grading);
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

function peopleSummary(grading){
 const rows=grading.target_results,ids=grading.structure?.targetIds,matching=grading.structure?.matchingIds,compression=grading.structure?.compressionIds;
 if(!Array.isArray(rows)||!Array.isArray(ids)||!Array.isArray(matching)||!Array.isArray(compression)||ids.length!==25||matching.length!==15||compression.length!==10||new Set(ids).size!==25||new Set([...matching,...compression]).size!==25||[...matching,...compression].some(id=>!ids.includes(id))||rows.length!==25||new Set(rows.map(r=>r.target_id)).size!==25||rows.some(r=>!ids.includes(r.target_id)||!['correct','partial','incorrect','missing'].includes(r.verdict)))return null;
 const correct=group=>rows.filter(r=>group.includes(r.target_id)&&r.verdict==='correct').length,needsRepair=rows.filter(r=>r.verdict!=='correct').map(r=>r.target_id);
 return {version:1,kind:'matching_people',matchingCorrect:correct(matching),matchingTotal:15,compressionCorrect:correct(compression),compressionTotal:10,total:25,correctCount:25-needsRepair.length,remainingCount:needsRepair.length,needsRepair,allCorrect:needsRepair.length===0};
}

export function reading67HeadingsSummary(grading){
 const rows=grading.target_results,ids=grading.structure?.targetIds,headings=grading.structure?.headingIds;
 if(!Array.isArray(rows)||!Array.isArray(ids)||!Array.isArray(headings)||ids.length!==15||headings.length!==5||new Set(ids).size!==ids.length||rows.length!==ids.length||new Set(rows.map(r=>r.target_id)).size!==ids.length||headings.some(id=>!ids.includes(id))||rows.some(r=>!ids.includes(r.target_id)||!['correct','partial','incorrect','missing'].includes(r.verdict)))return null;
 const matching=rows.filter(r=>headings.includes(r.target_id)),compression=rows.filter(r=>!headings.includes(r.target_id)),needsRepair=rows.filter(r=>r.verdict!=='correct').map(r=>r.target_id);
 return {version:1,kind:'matching_headings',matchingCorrect:matching.filter(r=>r.verdict==='correct').length,matchingTotal:5,compressionCorrect:compression.filter(r=>r.verdict==='correct').length,compressionTotal:10,total:15,correctCount:15-needsRepair.length,remainingCount:needsRepair.length,needsRepair,allCorrect:needsRepair.length===0};
}

export function reading67ProgressText(progress) {
  if (!progress) return '';
  if(progress.kind==='tfng')return ` Kết quả: kết luận toàn câu đúng ${progress.conclusionCorrect}/${progress.conclusionTotal}; T/F/NG theo mảnh đúng ${progress.labelCorrect}/${progress.labelTotal}; nội dung đối chiếu đạt ${progress.evidenceCorrect}/${progress.evidenceTotal}.`+(progress.allCorrect?' Đã sửa đúng toàn bộ bài.':` Còn ${progress.remainingCount} phần cần sửa.`);
  return ` Kết quả: đúng ${progress.matchingCorrect}/${progress.matchingTotal} câu. Phần nén: ${progress.compressionCorrect}/${progress.compressionTotal} phần đạt.` +
    (progress.allCorrect ? ' Đã sửa đúng toàn bộ bài.' : ` Còn ${progress.remainingCount} phần cần sửa.`);
}

function tfngSummary(grading){
 const rows=grading.target_results,ids=grading.structure?.targetIds,questions=grading.structure?.questionIds;
 if(!Array.isArray(rows)||!Array.isArray(ids)||!Array.isArray(questions)||!questions.length||new Set(ids).size!==ids.length||rows.length!==ids.length||new Set(rows.map(r=>r.target_id)).size!==ids.length||rows.some(r=>!ids.includes(r.target_id)||!['correct','partial','incorrect','missing'].includes(r.verdict)))return null;
 const group=kind=>rows.filter(r=>r.kind===kind),evidence=group('evidence'),labels=group('chunk_label'),conclusions=group('conclusion');
 if(evidence.length!==questions.length*3||labels.length!==evidence.length||conclusions.length!==questions.length||rows.length!==evidence.length+labels.length+conclusions.length)return null;
 if(questions.some(q=>evidence.filter(r=>r.question===q).length!==3||labels.filter(r=>r.question===q).length!==3||conclusions.filter(r=>r.question===q).length!==1))return null;
 const correct=xs=>xs.filter(r=>r.verdict==='correct').length,needsRepair=rows.filter(r=>r.verdict!=='correct').map(r=>r.target_id);
 return {version:1,kind:'tfng',evidenceCorrect:correct(evidence),evidenceTotal:evidence.length,labelCorrect:correct(labels),labelTotal:labels.length,conclusionCorrect:correct(conclusions),conclusionTotal:conclusions.length,total:rows.length,correctCount:rows.length-needsRepair.length,remainingCount:needsRepair.length,needsRepair,allCorrect:needsRepair.length===0};
}

function greenRoofsSummary(grading){
 const rows=grading.target_results,ids=grading.structure?.targetIds,choices=grading.structure?.choiceIds,compression=grading.structure?.compressionIds;
 if(!Array.isArray(rows)||!Array.isArray(ids)||!Array.isArray(choices)||!Array.isArray(compression)||ids.length!==14||choices.length!==4||compression.length!==10||new Set(ids).size!==14||new Set([...choices,...compression]).size!==14||[...choices,...compression].some(id=>!ids.includes(id))||rows.length!==14||new Set(rows.map(r=>r.target_id)).size!==14||rows.some(r=>!ids.includes(r.target_id)||!['correct','partial','incorrect','missing'].includes(r.verdict)))return null;
 const correct=group=>rows.filter(r=>group.includes(r.target_id)&&r.verdict==='correct').length,needsRepair=rows.filter(r=>r.verdict!=='correct').map(r=>r.target_id);
 return {version:1,kind:'green-roofs',matchingCorrect:correct(choices),matchingTotal:4,compressionCorrect:correct(compression),compressionTotal:10,total:14,correctCount:14-needsRepair.length,remainingCount:needsRepair.length,needsRepair,allCorrect:needsRepair.length===0};
}
