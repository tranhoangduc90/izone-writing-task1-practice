// Completion only; preserve the original answer for storage and semantic grading.
export function hasAnswerContent(raw){
 const value=String(raw??'').replace(/\p{Cf}/gu,'').trim();
 const choice=/^Lựa chọn: ?([^\n]*)\nDẫn chứng: ?([\s\S]*)$/u.exec(value);
 if(choice)return hasAnswerContent(choice[1])||hasAnswerContent(choice[2]);
 const slots=/^\(a\) ?([\s\S]*?)\n\(b\) ?([\s\S]*?)\n\(c\) ?([\s\S]*)$/u.exec(value);
 if(slots)return slots.slice(1).some(hasAnswerContent);
 return Boolean(value)&&!/^(?:[\s.\p{Pd}_…]+|n\/?a)$/iu.test(value);
}
