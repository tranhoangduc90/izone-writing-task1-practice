// Cấu hình cũ chỉ dùng khi đọc registry Lesson 5 chưa chuyển đổi; không chứa rubric.
// Registry mới sở hữu đề, nhãn giao diện, rubric và lớp trong cùng một file riêng tư.
export const LEGACY_LESSON5={
 activity:'lesson5',number:5,title:'Mua đồ không cần thiết',shortTitle:'Mua đồ không cần thiết',body:2,
 topic:'Many people buy products that they do not really need and replace old products with new ones unnecessarily. Why do people buy things they do not need? Do you think this is a good thing?',
 aInstruction:'Có bám sát đề không? Tả rõ việc mua đồ không cần thiết hoặc tình tiết xảy ra ngay sau việc mua.',
 ideaHint:'Chọn tác hại bạn sẽ bàn luận trong thân bài này.',promptVersion:'lesson5-rubric-v3'
};
const fields=['activity','number','title','shortTitle','body','topic','aInstruction','ideaHint','promptVersion','classes','defaultClass'];
export function publicLesson(lesson){return Object.fromEntries(fields.filter(k=>lesson[k]!==undefined).map(k=>[k,lesson[k]]));}
export function validateLesson(value,key){
 if(!value||value.activity!==key||!/^lesson[1-9]\d*$/.test(key)||!Number.isSafeInteger(value.number)||key!=='lesson'+value.number||value.body!==2||['title','shortTitle','topic','aInstruction','ideaHint','promptVersion'].some(k=>typeof value[k]!=='string'||!value[k].trim())||!Array.isArray(value.classes)||!value.classes.length||value.classes.some(c=>typeof c!=='string'||!c.trim()))throw new Error('LESSON_CONFIG_INVALID');
 if(value.defaultClass!==undefined&&!value.classes.includes(value.defaultClass))throw new Error('LESSON_CONFIG_INVALID');
 return publicLesson(value);
}
