/** Kiểm đủ audit và nhận xét; trả danh sách lỗi để AI sửa đúng ô, không tạo lời giải thay AI. */
export const VALIDATION_VERSION = 'materials-validation-20261026-v1';
const copy=value=>JSON.parse(JSON.stringify(value));
const text=value=>String(value??'').normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').replace(/\s+/g,' ').trim();
const evidence=value=>text(value).toLocaleLowerCase('vi').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const keys=(value,wanted)=>value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...wanted].sort());
const resultKeys=['target_id','unit_audit','relation_status','economy_status','critical_failure','primary_issue_unit_id','proposed_error_code','why_student_wrong'];
export function validateAudit(value,targets,profile,chooseIssue,feedbackStatesProblem=value=>/(chưa|thiếu|nhầm|sai|không|quá)/iu.test(value)) {
  const issues=[],decisions={},accepted={};
  const add=(targetId,field,code,message,scope='audit')=>issues.push({targetId,field,code,message,scope});
  if(!keys(value,['schema_version','lesson_id','prompt_version','oracle_version','results']))return {issues:[{targetId:null,field:'response',code:'AI_SCHEMA_INVALID',message:'Phản hồi thiếu/thừa trường hoặc không phải JSON object.',scope:'response'}],accepted,decisions};
  for(const [field,expected] of [['schema_version',profile.ai_schema_version],['lesson_id',profile.lesson_id],['prompt_version',profile.prompt_version],['oracle_version',profile.oracle_version]])if(value[field]!==expected)add(null,field,'AI_VERSION_MISMATCH','Phản hồi không thuộc bài/phiên bản đang chấm.','identity');
  if(issues.length)return {issues,accepted,decisions};
  if(!Array.isArray(value.results))return {issues:[{targetId:null,field:'results',code:'AI_RESULTS_INVALID',message:'results phải là mảng.',scope:'response'}],accepted,decisions};
  const expectedIds=new Set(targets.map(t=>t.target_id)),byId=new Map();
  for(const result of value.results){
    if(!expectedIds.has(result?.target_id)){add(null,'target_id','AI_TARGET_UNKNOWN','Phản hồi chứa ID ô ngoài yêu cầu.','identity');continue;}
    if(byId.has(result.target_id)){byId.set(result.target_id,null);add(result.target_id,'target_id','AI_TARGET_DUPLICATE','Ô xuất hiện nhiều lần.');}else byId.set(result.target_id,result);
  }
  for(const target of targets){
    const id=target.target_id,raw=byId.get(id),oracle=profile.structured_oracles[id];
    if(!oracle)throw Object.assign(Error('GRADER_ORACLE_MISSING'),{code:'GRADER_ORACLE_MISSING'});
    if(!raw){if(!byId.has(id))add(id,'result','AI_TARGET_MISSING','Thiếu kết quả ô này.');continue;}
    if(!keys(raw,resultKeys)){add(id,'result','AI_FIELDS_INVALID','Kết quả ô thiếu/thừa trường.');continue;}
    const start=issues.length,units=[...oracle.core_units,...oracle.secondary_required_units,...oracle.optional_units];
    if(typeof raw.why_student_wrong!=='string')add(id,'why_student_wrong','AI_EXPLANATION_TYPE','Lời giải thích phải là chuỗi.','feedback');
    if(!Array.isArray(raw.unit_audit)||raw.unit_audit.length!==units.length)add(id,'unit_audit','AI_UNITS_INVALID','Phải phân tích đủ mỗi ý đúng một lần.');
    else{
      const observed=new Map(raw.unit_audit.map(u=>[u?.unit_id,u]));
      if(observed.size!==units.length)add(id,'unit_audit','AI_UNIT_DUPLICATE','Ý bị trùng.');
      for(const unit of units){
        const row=observed.get(unit.id);
        if(!keys(row,['unit_id','status','student_span'])||!['present','absent','contradicted','uncertain'].includes(row?.status)){add(id,`unit_audit.${unit.id}`,'AI_UNIT_INVALID','Thiếu ý hoặc trạng thái không hợp lệ.');continue;}
        if(row.status==='absent'&&row.student_span!==null)add(id,`unit_audit.${unit.id}.student_span`,'AI_EVIDENCE_INVALID','Ý vắng mặt phải có dẫn chứng null.');
        if(row.student_span!==null&&typeof row.student_span!=='string')add(id,`unit_audit.${unit.id}.student_span`,'AI_EVIDENCE_TYPE','Dẫn chứng phải là chuỗi hoặc null.');
        if(['present','contradicted'].includes(row.status)&&(!evidence(row.student_span)||!evidence(target.student_response).includes(evidence(row.student_span))))add(id,`unit_audit.${unit.id}.student_span`,'AI_EVIDENCE_INVALID','Dẫn chứng phải là đoạn thật trong bài làm.');
        if(row.status==='uncertain'&&row.student_span!==null&&(!evidence(row.student_span)||!evidence(target.student_response).includes(evidence(row.student_span))))add(id,`unit_audit.${unit.id}.student_span`,'AI_EVIDENCE_INVALID','Dẫn chứng chưa chắc chắn cũng phải thuộc bài làm.');
      }
    }
    if(!['correct','partial','wrong','not_applicable'].includes(raw.relation_status)||(oracle.required_relation.applicable?raw.relation_status==='not_applicable':raw.relation_status!=='not_applicable'))add(id,'relation_status','AI_RELATION_INVALID','Trạng thái quan hệ không phù hợp tiêu chí.');
    if(!(oracle.economy_applicable?['adequate','too_close_to_source','uncertain']:['not_applicable']).includes(raw.economy_status))add(id,'economy_status','AI_ECONOMY_INVALID','Trạng thái độ cô đọng không phù hợp tiêu chí.');
    if(raw.critical_failure!==null&&!oracle.critical_failures.some(f=>f.id===raw.critical_failure))add(id,'critical_failure','AI_FAILURE_INVALID','Mã lỗi nghiêm trọng không có trong tiêu chí.');
    const unitIds=[...units.map(u=>u.id),oracle.required_relation.id,...oracle.critical_failures.map(f=>f.id),'economy'];
    if(raw.primary_issue_unit_id!==null&&!unitIds.includes(raw.primary_issue_unit_id))add(id,'primary_issue_unit_id','AI_ISSUE_INVALID','Ý lỗi không có trong tiêu chí.');
    if(raw.proposed_error_code!==null&&!profile.error_codes.includes(raw.proposed_error_code))add(id,'proposed_error_code','AI_ERROR_CODE_INVALID','Mã lỗi ngoài danh sách.');
    if(issues.length>start)continue;
    const normalized=copy(raw);normalized.unit_audit=units.map(u=>normalized.unit_audit.find(row=>row.unit_id===u.id));
    const decision=chooseIssue(normalized,oracle);decisions[id]=decision;accepted[id]=normalized;
    if(decision.verdict!=='correct'){
      const explanation=text(raw.why_student_wrong);
      if(explanation.length<18||explanation.length>520)add(id,'why_student_wrong','AI_EXPLANATION_LENGTH','Viết giải thích cụ thể dài 18–520 ký tự.','feedback');
      else if(/semantic unit|proposition|verdict|error[_ -]?code|primary_issue|critical_failure|economy_status|relation_status/i.test(explanation)||(explanation.match(/→|=>|\//g)||[]).length>1)add(id,'why_student_wrong','AI_EXPLANATION_LANGUAGE','Viết tiếng Việt dễ hiểu, bỏ thuật ngữ nội bộ và chuỗi ký hiệu.','feedback');
      else if(!feedbackStatesProblem(explanation))add(id,'why_student_wrong','AI_EXPLANATION_UNSPECIFIC','Chỉ rõ bài làm đang thiếu hoặc sai điều gì; dùng cách nói Em còn thiếu…, Em chưa nêu… hoặc Em đang nhầm….','feedback');
    }
  }
  return {issues,accepted,decisions};
}

export function mergeRepair(value,response,issues,targets,profile) {
  if(!response||!Array.isArray(response.results))throw Object.assign(Error('AI_REPAIR_SCHEMA_INVALID'),{code:'AI_REPAIR_SCHEMA_INVALID'});
  const original=copy({schema_version:profile.ai_schema_version,lesson_id:profile.lesson_id,prompt_version:profile.prompt_version,oracle_version:profile.oracle_version,results:Array.isArray(value?.results)?value.results:[]});
  const allowed=new Map();for(const issue of issues)if(issue.targetId){
    const fields=allowed.get(issue.targetId)||new Set();fields.add(issue.scope==='feedback'?'why_student_wrong':['result','target_id'].includes(issue.field)?'*':issue.field?.split('.')[0]||'*');allowed.set(issue.targetId,fields);
  }
  if(!allowed.size)for(const target of targets)allowed.set(target.target_id,new Set(['*']));
  const expectedIds=new Set(targets.map(t=>t.target_id));
  const seen=new Set(),byId=new Map((original.results||[]).filter(r=>r&&typeof r==='object'&&expectedIds.has(r.target_id)).map(r=>[r.target_id,r]));
  for(const row of response.results){
    if(!allowed.has(row?.target_id)||seen.has(row.target_id))throw Object.assign(Error('AI_REPAIR_TARGET_MISMATCH'),{code:'AI_REPAIR_TARGET_MISMATCH'});
    seen.add(row.target_id);
    const previous=byId.get(row.target_id),fields=allowed.get(row.target_id);
    if(fields.size===1&&fields.has('why_student_wrong')&&!keys(row,['target_id','why_student_wrong']))throw Object.assign(Error('AI_REPAIR_LOCKED_FIELD'),{code:'AI_REPAIR_LOCKED_FIELD'});
    if(fields.has('*')||!previous)byId.set(row.target_id,row);
    else{
      for(const field of Object.keys(row))if(field!=='target_id'&&!fields.has(field)&&JSON.stringify(row[field])!==JSON.stringify(previous[field]))throw Object.assign(Error('AI_REPAIR_LOCKED_FIELD'),{code:'AI_REPAIR_LOCKED_FIELD'});
      for(const issue of issues.filter(i=>i.targetId===row.target_id&&i.field?.startsWith('unit_audit.'))){
        const dirtyUnits=new Set(issues.filter(i=>i.targetId===row.target_id&&i.field?.startsWith('unit_audit.')).map(i=>i.field.split('.')[1]));
        for(const unit of row.unit_audit||[])if(!dirtyUnits.has(unit.unit_id)&&JSON.stringify(unit)!==JSON.stringify(previous.unit_audit?.find(u=>u.unit_id===unit.unit_id)))throw Object.assign(Error('AI_REPAIR_LOCKED_FIELD'),{code:'AI_REPAIR_LOCKED_FIELD'});
        break;
      }
      byId.set(row.target_id,{...previous,...row});
    }
  }
  // Thiếu phần bổ sung vẫn để validator báo thiếu; không lấy phần tử đầu hoặc đoán ID.
  original.results=targets.map(t=>byId.get(t.target_id)).filter(Boolean);return original;
}
