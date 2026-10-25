import crypto from 'node:crypto';
import {withTransaction} from '../../src/db.js';
import {ApiError} from './service-runtime.js';

export const LESSON9_VERSION='sw-task2-lesson9-v1';
const sections={topic_sentence:['topic_sentence'],supporting_idea_1:['idea1_a','idea1_x','idea1_b'],supporting_idea_2:['idea2_a','idea2_x','idea2_b']};
const nonempty=value=>typeof value==='string'&&value.replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu,'').length>0;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Adapter của sản phẩm Writing: dữ liệu cũ không có pin tiếp tục ở legacy-v1.
// Action dùng transaction/version/requestId; không sửa attempt hay feedback đã chấm.
export function createLesson9Service({pool,lessonService,vocabularyService=null}){
  async function details(sessionRef){
    const session=await lessonService.sessionDetails(sessionRef);
    const [state,attempts,events]=await Promise.all([
      pool.query('SELECT ui_version AS version,data FROM writing_practice.lesson9_session_state WHERE session_id=$1',[session.id]),
      pool.query('SELECT public_id AS "attemptRef",snapshot FROM writing_practice.check_attempt WHERE session_id=$1',[session.id]),
      pool.query('SELECT request_id AS id,kind,before_data AS before,after_data AS after,created_at AS at FROM writing_practice.lesson9_action WHERE session_id=$1 ORDER BY created_at DESC',[session.id])
    ]);
    const snapshots=new Map(attempts.rows.map(a=>[a.attemptRef,a.snapshot]));
    return {...session,attempts:session.attempts.map(a=>({...a,snapshot:snapshots.get(a.attemptRef)})),ui:state.rows[0]||{version:'legacy-v1',data:{}},uiEvents:events.rows,uiVocabulary:vocabularyService?await vocabularyService.state(session.id,session.responses):null};
  }
  async function open(input){
    const session=await lessonService.openSession(input);
    await pool.query(`INSERT INTO writing_practice.lesson9_session_state(session_id,ui_version,data)
      SELECT session.id,rollout.ui_version,'{}'::jsonb FROM writing_practice.activity_session session
      JOIN writing_practice.lesson9_rollout rollout ON rollout.activity_id=session.activity_id
      WHERE session.id=$1 AND session.created_at>=rollout.starts_at ON CONFLICT DO NOTHING`,[session.id]);
    return details(session.sessionRef);
  }
  async function action({sessionRef,baseVersion,requestId,kind,field,value,section,confirmed}){
    const input={baseVersion,kind,field,value,section,confirmed},bodyHash=digest(input);
    await withTransaction(pool,async client=>{
      const found=await client.query(`SELECT session.id,session.response_data AS responses,session.draft_version AS version,
        state.ui_version,state.data FROM writing_practice.activity_session session
        JOIN writing_practice.lesson9_session_state state ON state.session_id=session.id
        WHERE session.public_id=$1 FOR UPDATE OF session,state`,[sessionRef]);
      const row=found.rows[0];
      if(!row||!['shops-lesson9-v1',LESSON9_VERSION].includes(row.ui_version))throw new ApiError(409,'LEGACY_SESSION','Phiên cũ giữ luồng hiện hành; chưa chuyển sang Lesson 9.');
      const prior=await client.query('SELECT body_hash FROM writing_practice.lesson9_action WHERE session_id=$1 AND request_id=$2',[row.id,requestId]);
      if(prior.rowCount){if(prior.rows[0].body_hash!==bodyHash)throw new ApiError(409,'REQUEST_ID_REUSED','Mã thao tác đã dùng.');return;}
      if(row.version!==baseVersion)throw new ApiError(409,'DRAFT_VERSION_CONFLICT','Bản nháp đã đổi ở tab khác.');
      const pending=await client.query("SELECT 1 FROM writing_practice.check_attempt WHERE session_id=$1 AND status IN ('queued','leased') LIMIT 1",[row.id]);
      if(pending.rowCount)throw new ApiError(409,'CHECK_IN_PROGRESS','Hãy chờ lượt Check đang xử lý.');
      const states=await client.query('SELECT section_key,locked FROM writing_practice.session_section WHERE session_id=$1 FOR UPDATE',[row.id]);
      const passed=key=>states.rows.some(s=>s.section_key===key&&s.locked);
      const data=structuredClone(row.data),responses={...row.responses},before={data:row.data,responses:row.responses};
      if(kind==='change_body'){
        if(confirmed!==true||!['body1','body2'].includes(value))throw new ApiError(400,'BODY_CHANGE_CONFIRMATION_REQUIRED','Cần xác nhận đổi thân bài.');
        responses.body_choice=value;data.idea2Opened=false;data.draft2Open=false;data.approvals={};data.editedFields=[];
        await client.query('UPDATE writing_practice.session_section SET locked=false,fail_streak=0,round_number=round_number+1,updated_at=now() WHERE session_id=$1',[row.id]);
      }else if(kind==='revise_draft'){
        if(!Object.keys(sections).every(passed)||!passed('draft'))throw new ApiError(409,'DRAFT_NOT_READY','Chưa có Draft đã chấm để sửa.');
        const prior=await client.query("SELECT snapshot FROM writing_practice.check_attempt WHERE session_id=$1 AND section_key='draft' AND status='completed' AND result_status='passed' ORDER BY completed_at DESC LIMIT 1",[row.id]);
        if(!prior.rowCount||['draft1','draft2'].every(f=>prior.rows[0].snapshot[f]===responses[f]))throw new ApiError(409,'DRAFT_UNCHANGED','Draft chưa thay đổi; kết quả đã chấm vẫn được giữ.');
        data.draftEdited=true;
        await client.query("UPDATE writing_practice.session_section SET locked=false,fail_streak=0,round_number=round_number+1,updated_at=now() WHERE session_id=$1 AND section_key='draft'",[row.id]);
      }else if(kind==='edit'){
        const key=Object.keys(sections).find(k=>sections[k].includes(field))||(field?.match(/^body[12]_idea[12]$/)?'topic_sentence':null);
        if(!key||!passed(key)||!nonempty(value))throw new ApiError(400,'INVALID_APPROVED_EDIT','Chỉ sửa ô đã thông qua và không để trống.');
        responses[field]=value;
        data.editedFields=[...new Set([...(data.editedFields||[]),field])];
      }else if(kind==='open_idea2'){
        if(!passed('topic_sentence')||!passed('supporting_idea_1'))throw new ApiError(409,'SECTION_PREREQUISITES_NOT_PASSED','Chưa hoàn thành ý 1.');
        data.idea2Opened=true;
      }else if(kind==='copy_draft'){
        if(!Object.keys(sections).every(passed)||!nonempty(responses.draft1))throw new ApiError(409,'DRAFT_NOT_READY','Hãy hoàn thành lập luận và viết Draft 1.');
        if(nonempty(responses.draft2)&&confirmed!==true)throw new ApiError(409,'OVERWRITE_CONFIRMATION_REQUIRED','Cần xác nhận trước khi thay Draft 2.');
        responses.draft2=responses.draft1;data.draft2Open=true;
      }else if(kind==='attest'){
        if(confirmed!==true||!sections[section])throw new ApiError(400,'PERMISSION_NOT_CONFIRMED','Cần xác nhận lời đồng ý của GV.');
        const defs=await client.query('SELECT required_fields,prerequisite_sections FROM writing_practice.activity_section_definition WHERE activity_id=(SELECT activity_id FROM writing_practice.activity_session WHERE id=$1) AND section_key=$2',[row.id,section]);
        const def=defs.rows[0];
        if(!def||!def.required_fields.every(f=>nonempty(responses[f]))||!def.prerequisite_sections.every(passed))throw new ApiError(409,'SECTION_PREREQUISITES_NOT_PASSED','Nội dung hoặc phần trước chưa hoàn tất.');
        const attempts=await client.query('SELECT 1 FROM writing_practice.check_attempt WHERE session_id=$1 AND section_key=$2 LIMIT 1',[row.id,section]);
        if(!attempts.rowCount)throw new ApiError(409,'CHECK_REQUIRED','Cần Check ít nhất một lần.');
        await client.query('UPDATE writing_practice.session_section SET locked=true,updated_at=now() WHERE session_id=$1 AND section_key=$2',[row.id,section]);
        data.approvals={...data.approvals,[section]:{source:'student_attested_teacher_permission',at:new Date().toISOString()}};
      }else throw new ApiError(400,'INVALID_ACTION','Thao tác không hợp lệ.');
      await client.query('UPDATE writing_practice.activity_session SET response_data=$2::jsonb,draft_version=draft_version+1,updated_at=now() WHERE id=$1',[row.id,JSON.stringify(responses)]);
      await client.query('UPDATE writing_practice.lesson9_session_state SET data=$2::jsonb WHERE session_id=$1',[row.id,JSON.stringify(data)]);
      await client.query('INSERT INTO writing_practice.lesson9_action(session_id,request_id,kind,body_hash,before_data,after_data) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',[row.id,requestId,kind,bodyHash,JSON.stringify(before),JSON.stringify({data,responses})]);
    });
    return details(sessionRef);
  }
  return {details,open,action};
}
