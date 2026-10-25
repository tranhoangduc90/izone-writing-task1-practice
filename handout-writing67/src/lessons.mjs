// Cấu hình cũ chỉ dùng khi đọc registry Lesson 5 chưa chuyển đổi; không chứa rubric.
// Registry mới sở hữu đề, nhãn giao diện, rubric và lớp trong cùng một file riêng tư.
export const LEGACY_LESSON5={
 activity:'lesson5',number:5,title:'Mua đồ không cần thiết',shortTitle:'Mua đồ không cần thiết',body:2,
 topic:'Many people buy products that they do not really need and replace old products with new ones unnecessarily. Why do people buy things they do not need? Do you think this is a good thing?',
 aInstruction:'Có bám sát đề không? Tả rõ việc mua đồ không cần thiết hoặc tình tiết xảy ra ngay sau việc mua.',
 ideaHint:'Chọn tác hại bạn sẽ bàn luận trong thân bài này.',promptVersion:'lesson5-rubric-v3'
};
const fields=['preparationMode','handoutMode','bodies','helpTitle','helpItems','description','workflowMode','workflowVersion','whyOptions','objective','activity','number','title','shortTitle','body','topic','aInstruction','ideaHint','promptVersion','classes','defaultClass'];
export function publicLesson(lesson){return Object.fromEntries(fields.filter(k=>lesson[k]!==undefined).map(k=>[k,lesson[k]]));}
export function validateLesson(value,key){
 if(value?.preparationMode!==undefined&&value.preparationMode!=='ideas-first-v1')throw new Error('LESSON_CONFIG_INVALID');
 if(value?.preparationMode!==undefined&&value.handoutMode!=='two-bodies-v1')throw new Error('LESSON_CONFIG_INVALID');
 if(value?.handoutMode==='two-bodies-v1'){
  if(value.activity!==key||!/^lesson[1-9]\d*$/.test(key)||key!=='lesson'+value.number||value.workflowMode!=='whole-chain-v1'||value.objective!=='BAX'||['title','shortTitle','topic','aInstruction','ideaHint','promptVersion','description','helpTitle'].some(k=>typeof value[k]!=='string'||!value[k].trim())||!Array.isArray(value.classes)||!value.classes.length||value.classes.some(c=>typeof c!=='string'||!c.trim())||!Array.isArray(value.bodies)||value.bodies.length!==2||value.bodies.some((b,i)=>b.body!==i+1||b.objective!=='BAX'||['title','focus','ideaHint','topicInstruction','chainInstruction','comparisonInstruction'].some(k=>typeof b[k]!=='string'||!b[k].trim()))||!Array.isArray(value.helpItems)||value.helpItems.length!==3||value.helpItems.some(x=>typeof x!=='string'||!x.trim())||value.defaultClass!==undefined&&!value.classes.includes(value.defaultClass))throw new Error('LESSON_CONFIG_INVALID');
  const safe={...value,bodies:value.bodies.map(b=>Object.fromEntries(['body','objective','title','focus','ideaHint','topicInstruction','chainInstruction','comparisonInstruction'].map(k=>[k,b[k]])))};
  return publicLesson(safe);
 }
 if(value?.handoutMode!==undefined)throw new Error('LESSON_CONFIG_INVALID');
 if(!value||value.activity!==key||!/^lesson[1-9]\d*$/.test(key)||!Number.isSafeInteger(value.number)||key!=='lesson'+value.number||!((!value.workflowMode||value.workflowMode==='guided-bax-v1')&&value.body===2||value.workflowMode==='whole-chain-v1'&&value.body===1)||['title','shortTitle','topic','aInstruction','ideaHint','promptVersion'].some(k=>typeof value[k]!=='string'||!value[k].trim())||!Array.isArray(value.classes)||!value.classes.length||value.classes.some(c=>typeof c!=='string'||!c.trim()))throw new Error('LESSON_CONFIG_INVALID');
 if(value.workflowMode==='whole-chain-v1'&&(!Array.isArray(value.whyOptions)||value.whyOptions.length!==3||value.whyOptions.some(x=>typeof x!=='string'||!x.trim())||value.objective!=='WHY'))throw new Error('LESSON_CONFIG_INVALID');
 if(value.defaultClass!==undefined&&!value.classes.includes(value.defaultClass))throw new Error('LESSON_CONFIG_INVALID');
 return publicLesson(value);
}
