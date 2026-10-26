import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAudit,mergeRepair} from '../src/reading-listening67/web-validation.js';
const profile={ai_schema_version:'audit-v1',lesson_id:'l10',prompt_version:'prompt-v1',oracle_version:'oracle-v1',error_codes:['MISSING'],structured_oracles:{a:{core_units:[{id:'U1'}],secondary_required_units:[],optional_units:[],required_relation:{applicable:false,id:'R'},economy_applicable:false,critical_failures:[]},b:{core_units:[{id:'U1'}],secondary_required_units:[],optional_units:[],required_relation:{applicable:false,id:'R'},economy_applicable:false,critical_failures:[]}}};
const targets=[{target_id:'a',student_response:'Coal creates fly ash.'},{target_id:'b',student_response:'Transport can reduce the benefit.'}];
const choose=row=>row.unit_audit[0].status==='present'?{verdict:'correct',feedback:null}:{verdict:'partial',feedback:'Em còn thiếu nguồn gốc vật liệu.'};
const row=id=>({target_id:id,unit_audit:[{unit_id:'U1',status:'absent',student_span:null}],relation_status:'not_applicable',economy_status:'not_applicable',critical_failure:null,primary_issue_unit_id:null,proposed_error_code:null,why_student_wrong:'Em chưa nêu nguồn gốc của vật liệu đang được nói tới.'});
const output=()=>({schema_version:'audit-v1',lesson_id:'l10',prompt_version:'prompt-v1',oracle_version:'oracle-v1',results:[row('a'),row('b')]});
test('Kiểm toàn bộ ô: gom thiếu giải thích, dẫn chứng giả và trạng thái sai',()=>{
 const value=output();value.results[0].why_student_wrong='';value.results[1].unit_audit[0]={unit_id:'U1',status:'present',student_span:'A fabricated quote'};value.results[1].economy_status='invalid';
 const result=validateAudit(value,targets,profile,choose);
 assert.deepEqual(result.issues.map(i=>i.code),['AI_EXPLANATION_LENGTH','AI_EVIDENCE_INVALID','AI_ECONOMY_INVALID']);assert.equal(value.results[1].unit_audit[0].status,'present');
});
test('Không chấp nhận giải thích đủ dài nhưng chung chung hoặc thuật ngữ nội bộ',()=>{
 for(const text of ['Em hãy tiếp tục cố gắng và luyện tập nhiều hơn.','Em chưa xác định đúng semantic unit trong bài.']){
  const value=output();value.results[0].why_student_wrong=text;assert.equal(validateAudit(value,targets,profile,choose).issues[0].targetId,'a');
 }
});
test('Thiếu, trùng, sai ID/version được phân biệt; đảo thứ tự vẫn ghép theo ID',()=>{
 const valid=output();valid.results.reverse();assert.equal(validateAudit(valid,targets,profile,choose).issues.length,0);
 const missing=output();missing.results.pop();assert.equal(validateAudit(missing,targets,profile,choose).issues[0].code,'AI_TARGET_MISSING');
 const dup=output();dup.results.push(row('a'));assert.equal(validateAudit(dup,targets,profile,choose).issues[0].code,'AI_TARGET_DUPLICATE');
 const other=output();other.lesson_id='other';assert.equal(validateAudit(other,targets,profile,choose).issues[0].scope,'identity');
 const unknown=output();unknown.results.push(row('other'));assert.equal(validateAudit(unknown,targets,profile,choose).issues[0].scope,'identity');
});
test('Bổ sung chỉ feedback giữ nguyên audit và ô đã đạt; chặn sửa trường khóa',()=>{
 const value=output();value.results[0].why_student_wrong='';const issues=validateAudit(value,targets,profile,choose).issues;
 const fixed=mergeRepair(value,{results:[{target_id:'a',why_student_wrong:'Em chưa nêu nguồn gốc của tro bay trong câu trả lời.'}]},issues,targets,profile);
 assert.deepEqual(fixed.results[0].unit_audit,value.results[0].unit_audit);assert.deepEqual(fixed.results[1],value.results[1]);assert.equal(validateAudit(fixed,targets,profile,choose).issues.length,0);
 assert.throws(()=>mergeRepair(value,{results:[row('a')]},issues,targets,profile),{code:'AI_REPAIR_LOCKED_FIELD'});
 assert.throws(()=>mergeRepair(value,{results:[{target_id:'b',why_student_wrong:'x'}]},issues,targets,profile),{code:'AI_REPAIR_TARGET_MISMATCH'});
});
test('Bổ sung phản hồi hỏng dựng lại đúng hợp đồng; bổ sung vẫn thiếu chưa được coi đạt',()=>{
 const issue=[{targetId:null,scope:'response'}];
 const fixed=mergeRepair(null,{results:[row('b'),row('a')]},issue,targets,profile);assert.equal(validateAudit(fixed,targets,profile,choose).issues.length,0);
 const missing=mergeRepair(null,{results:[row('a')]},issue,targets,profile);assert.equal(validateAudit(missing,targets,profile,choose).issues[0].code,'AI_TARGET_MISSING');
});
test('Dẫn chứng số không được ép kiểu; lỗi độ cô đọng không mở khóa phân tích',()=>{
 const value=output();value.results[0].unit_audit[0]={unit_id:'U1',status:'present',student_span:100};
 assert(validateAudit(value,[{...targets[0],student_response:'100'},targets[1]],profile,choose).issues.some(i=>i.code==='AI_EVIDENCE_TYPE'));
 const clean=output();clean.results[0].economy_status='invalid';const issues=validateAudit(clean,targets,profile,choose).issues;
 const altered={...row('a'),unit_audit:[{unit_id:'U1',status:'present',student_span:'Coal'}]};
 assert.throws(()=>mergeRepair(clean,{results:[altered]},issues,targets,profile),{code:'AI_REPAIR_LOCKED_FIELD'});
 const patched=mergeRepair(clean,{results:[{target_id:'a',economy_status:'not_applicable'}]},issues,targets,profile);assert.deepEqual(patched.results[0].unit_audit,clean.results[0].unit_audit);
});
test('Review nội dung từ chối audit cho phép sửa relation của đúng ô',()=>{
 const clean=output(),changed=row('a');changed.relation_status='partial';
 const fixed=mergeRepair(clean,{results:[changed]},[{targetId:'a',scope:'audit',field:'result'}],targets,profile);
 assert.equal(fixed.results[0].relation_status,'partial');assert.deepEqual(fixed.results[1],clean.results[1]);
});
test('JSON hỏng có null trong results vẫn được bổ sung thành công',()=>{
 const fixed=mergeRepair({results:[null,'invalid',{}]},{results:[row('a'),row('b')]},[{targetId:null,field:'response',scope:'response'}],targets,profile);
 assert.equal(validateAudit(fixed,targets,profile,choose).issues.length,0);
});
