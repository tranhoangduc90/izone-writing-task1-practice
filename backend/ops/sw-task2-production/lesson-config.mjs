import lessons from './lessons.json' with {type:'json'};
export const LESSONS=Object.freeze(lessons);
export const ENABLED_LESSONS=Object.values(LESSONS).filter(l=>l.previewAvailable).map(l=>l.slug);
export function requireLesson(slug){const lesson=LESSONS[slug];if(!lesson||!lesson.previewAvailable)throw Object.assign(Error('Đề chưa được mở.'),{status:404,code:'LESSON_NOT_AVAILABLE'});return lesson;}
export const promptRecord=slug=>'sw-task2:'+requireLesson(slug).slug+':lesson9-v1';
