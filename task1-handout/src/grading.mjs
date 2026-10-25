import crypto from 'node:crypto';
export const sha=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const inputNames={de_bai:'taskPrompt',overview:'overview',body_1:'body1',body_2:'body2',draft1:'draft1',draft2:'draft2'};
export function renderPrompt(context){
 if(context.productId!=='sw-task1'||!['overview','outline','draft'].includes(context.section)||sha(context.template)!==context.promptSha256)throw Error('PROMPT_CONTEXT_INVALID');
 // One replacement pass: learner text containing a placeholder is data, never re-expanded.
 const history=context.history.map((item,i)=>`Lượt ${i+1}: ${typeof item==='string'?item:JSON.stringify(item)}`).join('\n\n')||'(Chưa có phản hồi trước đó)';
 return context.template.replaceAll('\r\n','\n').replace(/\{\{\s*\$json\.(\w+)\s*\}\}|\{\{FEEDBACK_HISTORY\}\}/g,(all,key)=>key==='de_bai'?context.taskPrompt:key?String(context.snapshot[inputNames[key]]??''):history);
}
export function readModel(value){
 if(Array.isArray(value)){if(value.length!==1)throw Error('AI_RESULT_AMBIGUOUS');value=value[0];}
 if(value?.error||value?.ok===false)throw Error('AI_RESULT_FAILED');
 const candidates=value?.candidates||value?.data?.candidates;
 const c=candidates?.[0];
 if(!c||c.finishReason!=='STOP')throw Error('AI_RESULT_INCOMPLETE');
 const feedback=c.content?.parts?.filter(x=>!x.thought&&typeof x.text==='string').map(x=>x.text).join('\n').trim();
 if(!feedback)throw Error('AI_RESULT_EMPTY');
 return {feedback,modelVersion:value.modelVersion||value.data?.modelVersion,usage:value.usageMetadata||value.data?.usageMetadata};
}
export function validateFeedback(feedback,section){
 const limit=section==='overview'?120:150;
 if(typeof feedback!=='string'||feedback.split(/\s+/u).filter(Boolean).length>limit)throw Error('AI_FEEDBACK_TOO_LONG');
 const label={overview:'Overview đã đạt',outline:'Outline hai thân bài đã đạt',draft:'Draft đã đạt'}[section];
 const passed=feedback.startsWith(label+' 👍');
 if(!passed&&!['Chẩn đoán:','Phân tích:','Gợi mở:','Next step:'].every(x=>feedback.replaceAll('**','').includes(x)))throw Error('AI_FEEDBACK_CONTRACT');
 if(section==='draft'&&/câu sửa|revised[_ ](?:text|sentence)|```|_{3,}/iu.test(feedback))throw Error('AI_WROTE_FOR_STUDENT');
 return passed?'passed':'needs_revision';
}
export function normalizeFeedback(feedback,section){
 const limit=section==='overview'?120:150;
 if(feedback.split(/\s+/u).filter(Boolean).length<=limit)return feedback;
 // Preserve the first issue verbatim; do not cut sentences or generate academic content.
 const second=feedback.search(/\n\s*2\.\s+\*\*Chẩn đoán:/u);
 if(second<0)return feedback;
 let first=feedback.slice(0,second).trim();
 if(!first.replaceAll('**','').includes('Next step:'))first+='\n**Next step:** Em tự sửa phần vừa được hỏi và giữ các phần đúng.';
 return first.split(/\s+/u).filter(Boolean).length<=limit?first:feedback;
}
export async function gradeJob({job,context,aiUrl,call=fetch}){
 const prompt=renderPrompt(context);
 const response=await call(aiUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,anh_minh_hoa:''}),signal:AbortSignal.timeout(150000)});
 if(!response.ok)throw Error('AI_HTTP_FAILED');
 const value=readModel(await response.json()),feedback=normalizeFeedback(value.feedback,job.section);
 return {resultStatus:validateFeedback(feedback,job.section),feedback,artifacts:{productId:'sw-task1',attemptRef:job.jobRef,mode:'socratic-v2',promptVersion:context.promptVersion,promptSha256:context.promptSha256,renderedPromptSha256:sha(prompt),snapshotSha256:sha(context.snapshot),rawFeedbackSha256:sha(value.feedback),feedbackReduced:feedback!==value.feedback,modelVersion:value.modelVersion,usage:value.usage}};
}
