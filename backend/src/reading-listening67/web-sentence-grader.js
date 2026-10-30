/** Kế thừa nguyên bộ chấm CTA Athletes and stress hiện hành, không gọi writer Docs cũ. */
import {loadReading67CtaGrader} from './web-headings-grader.js';
export async function loadReading67SentenceGrader(options){
 const grader=await loadReading67CtaGrader({...options,contract:{workflowId:'5kghTUphTSvJ9RgT',lessonId:'l6',layout:'sc_legacy_v1',expected:28,minimum:23,kind:'sentence_completion',validationVersion:'reading-sentence-validation-20261030-v1'}});
 return {...grader,config:{...grader.config,code:'67-reading-athletes-and-stress',version:'athletes-and-stress-20261030-v1'}};
}
