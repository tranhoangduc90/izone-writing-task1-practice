// Dữ liệu giả giữ đủ 4 câu và 16 phần nén; thiếu kết quả không được báo đạt.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reading67ResultSummary,reading67ProgressText} from '../src/reading-listening67/web-result-summary.js';
const ids=[...'ABCDEFGH'].map(x=>'p.'+x).concat([1,2,3,4].flatMap(n=>['radar','evidence_l1','section'].map(x=>'q.'+n+'.'+x)));
const result=()=>({grading:{target_results:ids.map(target_id=>({target_id,verdict:'correct'}))}});
test('4/4 Matching vẫn cần sửa nếu nén partial/missing; chỉ 20/20 mới đạt toàn bộ',()=>{
 const r=result();r.grading.target_results[0].verdict='partial';r.grading.target_results[1].verdict='missing';
 const p=reading67ResultSummary(r);assert.equal(p.matchingCorrect,4);assert.equal(p.compressionCorrect,14);assert.equal(p.remainingCount,2);assert.equal(p.allCorrect,false);
 assert.match(reading67ProgressText(p),/đúng 4\/4 câu.*14\/16.*Còn 2 phần cần sửa/);
 const all=reading67ResultSummary(result());assert.equal(all.allCorrect,true);assert.match(reading67ProgressText(all),/Đã sửa đúng toàn bộ/);
});
test('0/4 giữ mẫu số; thiếu, trùng ID hoặc verdict lạ không bịa điểm',()=>{
 const r=result();for(const row of r.grading.target_results)row.verdict='incorrect';
 assert.equal(reading67ResultSummary(r).matchingCorrect,0);assert.equal(reading67ResultSummary(r).remainingCount,20);
 for(const change of [r=>r.grading.target_results.pop(),r=>r.grading.target_results[1].target_id=ids[0],r=>r.grading.target_results[0].verdict='unverified']){
  const bad=result();change(bad);assert.equal(reading67ResultSummary(bad),null);
 }
 assert.equal(reading67ResultSummary(null),null);assert.equal(reading67ProgressText(null),'');
});
