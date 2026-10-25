// Hai thân bài dùng cùng chính sách chấm; khóa có tiền tố giữ đúng nguồn–đích khi lưu/AI trả muộn.
export const GUIDED='guided-bax-v1', WHOLE='whole-chain-v1', MULTI='two-bodies-v1';
export const PREPARATION='ideas-first-v1';
export const SOLUTIONS=['Đường tàu và tàu điện ngầm','Thêm đường và mở rộng đường bộ'];
export const PLAN_FIELDS=['chosenSolution','body1_idea1','body1_idea2','body2_idea1','body2_idea2'];
export const ORDER=['topic','b1','a1','x1','b2','a2','x2'];
export const FIELDS={topic:['idea1','idea2','topicSentence'],b1:['b1'],a1:['a1'],x1:['x1'],b2:['b2'],a2:['a2'],x2:['x2']};
const whole={order:['topic','si1','si2'],fields:{topic:FIELDS.topic,si1:['a1','x1','b1'],si2:['a2','x2','b2']}};
export const isMulti=s=>s.handoutMode===MULTI;
export const isPrepared=s=>isMulti(s)&&s.preparationMode===PREPARATION;
export const isWhole=s=>s.workflowMode===WHOLE;
export const bodyIndexOf=key=>['outline','chosenSolution'].includes(key)?0:Number(/^body([12])_/.exec(String(key))?.[1])||null;
export const localKey=key=>String(key).replace(/^body[12]_/,'');
export const bodyKey=(n,key)=>'body'+n+'_'+key;
export const vocabularyKey=(s,n,b)=>isMulti(s)?'body'+b:n;
export const jobStateKey=j=>j.kind==='grade'?j.section:(j.bodyIndex?'body'+j.bodyIndex+'_':'')+'vocab'+j.ideaIndex;
const multi={order:[1,2].flatMap(n=>whole.order.map(k=>bodyKey(n,k))),fields:Object.fromEntries([1,2].flatMap(n=>whole.order.map(k=>[bodyKey(n,k),whole.fields[k].map(f=>bodyKey(n,f))])))};
const prepared={order:['outline',...multi.order],fields:{outline:PLAN_FIELDS,...Object.fromEntries(Object.entries(multi.fields).map(([k,v])=>[k,localKey(k)==='topic'?[bodyKey(bodyIndexOf(k),'topicSentence')]:v]))}};
export function workflowFor(value={}){
 const mode=value.workflowMode||GUIDED;
 if(![GUIDED,WHOLE].includes(mode))throw new Error('WORKFLOW_INVALID');
 return isPrepared(value)?prepared:isMulti(value)?multi:mode===WHOLE?whole:{order:ORDER,fields:FIELDS};
}
export function bodyView(s,n){
 const prefix='body'+n+'_';
 return {...s,handoutMode:undefined,preparationMode:undefined,bodies:undefined,body:n,bodyIndex:n,
 responses:Object.fromEntries(Object.values(whole.fields).flat().map(k=>[k,s.responses?.[prefix+k]||''])),
 steps:Object.fromEntries(whole.order.map(k=>[k,s.steps?.[prefix+k]||{status:'draft',history:[],error:null}])),
 idea2Open:!!s.bodyProgress?.[n]?.idea2Open,vocabulary:s.vocabulary?.['body'+n]?{0:s.vocabulary['body'+n]}:{},
 processing:Object.fromEntries(Object.entries(s.processing||{}).filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k.slice(prefix.length),v])),
 teacherComments:(s.teacherComments||[]).filter(c=>c.section?.startsWith(prefix)).map(c=>({...c,section:localKey(c.section)})),
 commentThreads:(s.commentThreads||[]).filter(c=>c.field?.startsWith(prefix)).map(c=>({...c,section:localKey(c.section),field:localKey(c.field)})),
 submittedSections:(s.submittedSections||[]).filter(k=>k.startsWith(prefix)).map(localKey)};
}
export const sectionFor=(s,field)=>workflowFor(s).order.find(k=>workflowFor(s).fields[k].includes(field));
export const ideaPassed=(s,n,b)=>isMulti(s)?[1,2].includes(b)&&ideaPassed(bodyView(s,b),n):isWhole(s)?s.steps['si'+n]?.status==='passed':['b','a','x'].every(k=>s.steps[k+n]?.status==='passed');
export function available(s,key){
 if(isPrepared(s)){if(key==='outline')return true;if(s.steps.outline?.status!=='passed')return false;}
 if(isMulti(s)){const b=bodyIndexOf(key);return !!b&&available(bodyView(s,b),localKey(key));}
 const order=workflowFor(s).order,i=order.indexOf(key);
 return i>=0&&(i===0||s.steps[order[i-1]]?.status==='passed')&&(!key.endsWith('2')||s.idea2Open);
}
export const vocabEligible=(s,n,b)=>isMulti(s)?[1,2].includes(b)&&n===0&&ideaPassed(s,1,b)&&ideaPassed(s,2,b):isWhole(s)?n===0&&ideaPassed(s,1)&&ideaPassed(s,2):[1,2].includes(n)&&ideaPassed(s,n);
export const vocabFields=(n,b)=>(n===0?[1,2]:[n]).flatMap(i=>['a','x','b'].map(k=>(b?'body'+b+'_':'')+k+i));
export function bodyConfig(lesson,s,n){
 const original=lesson.bodies.find(b=>b.body===n);
 if(!isPrepared(lesson))return original;
 const chosen=s.responses?.chosenSolution,valid=SOLUTIONS.includes(chosen),other=SOLUTIONS.find(x=>x!==chosen),solution=valid?(n===2?chosen:other):'';
 return {...original,title:(n===2?'Bảo vệ phương án chọn':'Đánh giá phương án không chọn')+(solution?' · '+solution:''),focus:n===2?'Dùng hai idea đã chốt để làm rõ vì sao phương án bạn chọn tốt hơn.':'Dùng hai idea đã chốt để chỉ ra hạn chế của phương án không chọn; có thể khen mở đầu rồi chuyển sang hạn chế.'};
}
