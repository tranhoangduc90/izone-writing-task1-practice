import { sha256 } from './writing-flow-crypto.js';

// Dữ liệu vào: bốn đề đang hiển thị trên Pages và prompt của bốn bộ chấm cũ.
// Việc chính: ghim đề, Task, phiên bản rubric và ảnh Task 1 theo bản đã đối chiếu.
// Kết quả: backend chỉ cấp lượt nếu khóa lớp–đề trỏ đúng một bản này.
// Khi lỗi: thiếu hoặc lệch pin thì chặn, không đoán đề từ dữ liệu trình duyệt.
export const WEB_SUBSTITUTE_REGISTRY = Object.freeze({
  'substitute-test-1-k56': Object.freeze({
    testSlug: 'substitute-test-1-k56', taskNumber: 2,
    rubricVersion: 'substitute-test1-k56-isolated-20260915-v1',
    topic: 'Many people think cheap air travel should be encouraged because it give ordinary people freedom to travel further. However, others think this leads to environmental problems, so air travel should be more expensive in order to discourage people from having it.\n\nDiscuss both views and give your own opinion.',
    promptSha256: '69d6d32283113876d8880e7e9ee3a5ecbfab6708584b1da5cccd211755e1014c',
    imageUrl: null, imageSha256: null,
  }),
  'substitute-test-2-k56': Object.freeze({
    testSlug: 'substitute-test-2-k56', taskNumber: 1,
    rubricVersion: 'substitute-test2-k56-isolated-20260917-v1',
    topic: 'The graph below shows the total revenue of three pizza places in Vietnam. The figures were taken in 2017.\n\nSummarise the information by selecting and reporting the main features, and make comparisons where relevant.',
    promptSha256: '15dd23b0cf568e94603f4a70f3955283589da927e09557b148f71673ac768729',
    imageUrl: 'https://ducizone.ddns.net/writing-assets/v1/1296e1095e8517d17208e7edb31a907c251d93ba21476d15b07629fea07fb612.png',
    imageSha256: '1296e1095e8517d17208e7edb31a907c251d93ba21476d15b07629fea07fb612',
  }),
  'substitute-test-1-k67': Object.freeze({
    testSlug: 'substitute-test-1-k67', taskNumber: 2,
    rubricVersion: 'test56-67-parity-20260908-v1',
    topic: 'Some people feel that the private lives of celebrities should not be openly shared by the media. To what extent do you agree or disagree?',
    promptSha256: 'c0d8f9702d4f405883b4b10d503f9a6e1c899ac117c2f627ecb03a98b74ec307',
    imageUrl: null, imageSha256: null,
  }),
  'substitute-test-2-k67': Object.freeze({
    testSlug: 'substitute-test-2-k67', taskNumber: 2,
    rubricVersion: 'test56-67-parity-20260909-v1',
    topic: 'Many cities are becoming increasingly crowded, and traffic congestion is getting worse. What problems does this cause, and what measures can be taken to solve them?',
    promptSha256: '70e510e863a55cceaf8847f7af2d29d1d885df428f962fe2acae77c47cb5415e',
    imageUrl: null, imageSha256: null,
  }),
});

export function getPinnedWebPrompt({ testSlug, taskNumber, rubricVersion }) {
  const pinned = WEB_SUBSTITUTE_REGISTRY[testSlug];
  if (!pinned || pinned.taskNumber !== Number(taskNumber)
    || pinned.rubricVersion !== rubricVersion) return null;
  const normalized = pinned.topic.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (sha256(normalized) !== pinned.promptSha256) return null;
  return pinned;
}
