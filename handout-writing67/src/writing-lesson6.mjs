export const LESSON6_SHARE_POLICY = 'writing67-lesson6-chat-v1';
export const LESSON6_STARTER = 'https://chatgpt.com/share/68d570d0-c548-8011-a8fd-f8fca8e7c07e';
export const LESSON6_TITLE = 'Chuẩn bị ý tưởng · Truy cập và trao đổi thông tin';
export const LESSON6_TOPIC = 'Modern technology now allows rapid and uncontrolled access to and exchange of information. Far from being beneficial, this is a danger to our societies. To what extent do you agree or disagree?';

export const LESSON6_STANCES = {
  agree: 'Đồng ý',
  disagree: 'Không đồng ý',
  partly_agree: 'Đồng ý một phần',
};

export const LESSON6_DIMENSIONS = {
  access: 'truy cập thông tin',
  exchange: 'trao đổi thông tin',
  rapid: 'tốc độ tiếp cận hoặc lan truyền',
  uncontrolled: 'việc thiếu kiểm soát',
};

export const isLesson6Outline = lesson => lesson?.activity === 'lesson6' && lesson.outlineOnly === true;
export const lesson6ShareEnabled = lesson => isLesson6Outline(lesson) && lesson.sharePolicy === LESSON6_SHARE_POLICY;

export function lesson6CoverageMissing(steps) {
  const covered = new Set(steps.flatMap(step => step?.status === 'passed' ? step.dimensions ?? [] : []));
  return Object.keys(LESSON6_DIMENSIONS).filter(dimension => !covered.has(dimension));
}

export function lesson6OutlineRelation(stance, steps) {
  if (!Object.hasOwn(LESSON6_STANCES, stance) || steps.some(step => step?.status !== 'passed')) return 'waiting';
  const [first, second] = steps.map(step => step.direction);
  if (![first, second].every(direction => ['agree', 'disagree', 'balanced'].includes(direction))) return 'waiting';
  const opposite = stance === 'agree' ? 'disagree' : 'agree';
  if (stance === 'partly_agree') {
    if (first === second && first !== 'balanced') return 'stance';
  } else {
    if (first === stance && second === opposite) return 'order';
    if (first !== opposite || second !== stance) return 'stance';
  }
  return lesson6CoverageMissing(steps).length ? 'coverage' : 'passed';
}
