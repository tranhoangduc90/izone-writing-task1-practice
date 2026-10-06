import {ORDER} from './service.mjs';

// Nhận hai trạng thái đã khóa trong transaction; giữ mốc hoạt động ngoài nhật ký hết hạn.
// Góp ý của GV và lượt đọc không đổi thời gian hoạt động học viên. Dữ liệu cũ thiếu mốc giữ null.
export function markDashboardActivity(before,after,now){
  const activity=after.dashboardActivity ||= {...before.dashboardActivity};
  if(JSON.stringify(before.responses)!==JSON.stringify(after.responses))activity.studentSavedAt=now;
  if(!before.idea2Open&&after.idea2Open)activity.studentOpenedIdea2At=now;
  const oldJobs=new Map(before.jobs.map(j=>[j.jobRef,j]));
  for(const j of after.jobs){
    const old=oldJobs.get(j.jobRef);
    if(!old&&j.kind==='grade')activity.studentCheckedAt=now;
    if(old&&old.status!==j.status){j.stateChangedAt=now;if(j.kind==='grade'&&['completed','failed'].includes(j.status))activity.resultAt=now;}
  }
  for(const key of ORDER)if(after.steps[key].approval?.source==='student_attested_teacher_permission'&&JSON.stringify(before.steps[key].approval)!==JSON.stringify(after.steps[key].approval))activity.studentAttestedAt=now;
  const oldMessages=new Set((before.commentThreads||[]).flatMap(t=>t.messages.map(m=>m.ref)));
  if((after.commentThreads||[]).some(t=>t.messages.some(m=>m.role==='student'&&!oldMessages.has(m.ref))))activity.studentRepliedAt=now;
}
const time=value=>typeof value==='number'?value:Number.isFinite(Date.parse(value))?Date.parse(value):0;
const max=(...values)=>Math.max(0,...values.map(time))||null;
const available=(s,key)=>{const i=ORDER.indexOf(key);return (i===0||s.steps[ORDER[i-1]].status==='passed')&&(!(key==='b2'||key==='a2'||key==='x2')||s.idea2Open);};

// Nhận phiên Handout67; chỉ trả thống kê và trạng thái cần đọc. Không trả prompt/token/snapshot job.
// Đếm một logical job là một Check; attempt kỹ thuật và từ vựng không được cộng vào đó.
export function dashboardProjection(s,now=Date.now()){
  const latest=Object.fromEntries(s.jobs.map(j=>[j.kind==='grade'?j.section:'vocab'+j.ideaIndex,j]));
  const processing=Object.fromEntries(Object.entries(latest).filter(([,j])=>['queued','leased','failed'].includes(j.status)&&!(j.kind==='grade'&&s.steps[j.section].status==='passed')).map(([k,j])=>[k,{
    jobRef:j.jobRef,status:j.status,tries:j.tries,maxTries:3,createdAt:j.createdAt,
    deadlineAt:j.deadlineAt??null,leaseUntil:j.leaseUntil||null,nextAttemptAt:j.nextAttemptAt??null,error:j.error??null,
    stateChangedAt:j.stateChangedAt??null,overdue:Number.isFinite(j.deadlineAt)&&now>j.deadlineAt
  }]));
  const stepStates=Object.fromEntries(ORDER.map(k=>[k,{status:s.steps[k].status,available:available(s,k),approval:s.steps[k].approval??null,editedAfterApproval:!!s.steps[k].editedAfterApproval,editedAt:s.steps[k].editedAt??null}]));
  const current=ORDER.find(k=>s.steps[k].status!=='passed'&&available(s,k))??null;
  let negativeStreak=0;
  if(current)for(const h of [...s.steps[current].history].reverse()){if(h.status!=='revision')break;negativeStreak++;}
  const threads=s.commentThreads||[],open=threads.filter(t=>t.status==='open');
  const waitingReplyAt=max(...open.map(t=>{const last=t.messages.at(-1);return last?.role==='student'?last.createdAt:0;}));
  const a=s.dashboardActivity||{};
  const checked=max(a.studentCheckedAt,...s.jobs.filter(j=>j.kind==='grade').map(j=>j.createdAt));
  const attested=max(a.studentAttestedAt,...ORDER.map(k=>s.steps[k].approval?.source==='student_attested_teacher_permission'?s.steps[k].approval.at:0));
  const edited=max(...ORDER.map(k=>s.steps[k].editedAt));
  const studentRepliedAt=max(a.studentRepliedAt,...threads.flatMap(t=>t.messages.filter(m=>m.role==='student').map(m=>m.createdAt)));
  const resultAt=max(a.resultAt,...s.jobs.filter(j=>j.kind==='grade'&&['completed','failed'].includes(j.status)).map(j=>j.stateChangedAt),...ORDER.map(k=>s.steps[k].approval?.source==='ai'?s.steps[k].approval.at:0));
  const passed=ORDER.filter(k=>s.steps[k].status==='passed').length;
  const attention=Object.values(processing).some(j=>j.status==='failed'||j.overdue);
  return {filled:Object.values(s.responses).filter(v=>typeof v==='string'&&v.trim()).length,passed,
    checks:s.jobs.filter(j=>j.kind==='grade').length,aiComments:ORDER.reduce((n,k)=>n+s.steps[k].history.length,0),
    current,currentLabel:!current&&passed<7?'Chờ học viên mở Ý 2':null,negativeStreak,supportLevel:negativeStreak>=9?9:negativeStreak>=6?6:negativeStreak>=3?3:0,
    openThreads:open.length,addressedThreads:threads.length-open.length,waitingReplyAt,
    attested:ORDER.filter(k=>s.steps[k].approval?.source==='student_attested_teacher_permission').length,
    edited:ORDER.filter(k=>s.steps[k].editedAfterApproval).length,stepStates,processing,
    activity:{studentSavedAt:a.studentSavedAt??null,studentCheckedAt:checked,studentAttestedAt:attested,studentRepliedAt,resultAt,
      studentAt:max(a.studentSavedAt,checked,attested,studentRepliedAt,edited,a.studentOpenedIdea2At),lastAt:max(a.studentSavedAt,checked,attested,studentRepliedAt,edited,a.studentOpenedIdea2At,resultAt)},
    state:negativeStreak>=3?'support':attention?'attention':passed===7?'complete':Object.values(processing).some(j=>['queued','leased'].includes(j.status))?'pending':current&&s.steps[current].status==='revision'?'revision':'working',
    priority:negativeStreak>=3?0:attention?1:edited||waitingReplyAt?2:passed<7?3:4};
}
