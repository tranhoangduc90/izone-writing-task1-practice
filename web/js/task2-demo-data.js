// Dữ liệu nhận vào: không có; đây là dữ liệu giả cho đề crime prevention trong handout mẫu.
// Việc chính: mô phỏng các trạng thái thường gặp từ lúc chưa làm đến khi xem kết quả Draft.
// Kết quả: trang demo có thể dựng toàn bộ luồng mà không gọi API, n8n, LMS hoặc database.
// Khi lỗi: chỉ trang demo bị thiếu dữ liệu; bài làm thật và hệ thống chấm không bị ảnh hưởng.

export const task2DemoTask = {
  title: "Crime prevention: government or individuals?",
  statement: "Some people think that the government should be responsible for crime prevention, while others believe that it is the responsibility of the individual to protect themselves. Discuss both views and give your opinion.",
};

const plan = {
  body1_message: "Chính phủ nên giữ trách nhiệm chính vì có thể phòng chống tội phạm trên quy mô toàn xã hội.",
  body1_idea1: "Chính phủ kiểm soát luật pháp và lực lượng thực thi, từ đó có thể răn đe hành vi phạm tội.",
  body1_idea2: "Chính phủ có thể xử lý nguyên nhân gốc rễ của tội phạm bằng giáo dục và cơ hội việc làm.",
  body2_message: "Cá nhân vẫn phải chủ động giảm rủi ro và hỗ trợ cộng đồng phát hiện tội phạm.",
  body2_idea1: "Mỗi người có thể bảo vệ nhà cửa, tài sản và tránh những tình huống nguy hiểm.",
  body2_idea2: "Người dân có thể báo cáo hành vi đáng ngờ và tham gia các mạng lưới bảo vệ khu dân cư.",
  body_choice: "body1",
};

const passedTopic = "Although individuals should take sensible precautions, governments should bear primary responsibility for crime prevention because they can enforce the law and address the social causes of offending.";

const passedIdea1 = {
  idea1_a: "Governments control the police, courts and criminal law.",
  idea1_x: "When penalties are enforced consistently, potential offenders are more likely to expect real consequences before committing an offence.",
  idea1_b: "This credible threat of punishment can deter criminal behaviour across society.",
};

const passedIdea2 = {
  idea2_a: "Governments can invest in education, employment programmes and support for disadvantaged communities.",
  idea2_x: "These measures reduce poverty, exclusion and limited opportunities, which can make vulnerable people more likely to offend.",
  idea2_b: "Addressing these underlying pressures can prevent crime before police intervention becomes necessary.",
};

const draft1 = "Although individuals should take sensible precautions, governments should bear primary responsibility for crime prevention because they can enforce the law and address its social causes. First, governments control the police, courts and criminal law. When <hình phạt được thực thi nhất quán>, potential offenders are more likely to expect real consequences before committing an offence. Therefore, effective law enforcement can deter criminal behaviour across society. In addition, governments can invest in education and employment programmes. By reducing <những nguyên nhân xã hội gốc rễ của tội phạm>, these measures can prevent vulnerable people from turning to illegal activity.";

const draft2 = "Although individuals should take sensible precautions, governments should bear primary responsibility for crime prevention because they can enforce the law and address its social causes. First, governments control the police, courts and criminal law. When legal penalties are enforced consistently, potential offenders are more likely to expect real consequences before committing an offence. Therefore, effective law enforcement can deter criminal behaviours across society. In addition, governments can invest in education and employment programmes. By reducing the deep social reasons of crime, these measures can prevent vulnerable people from turning to illegal activity.";

const vocabulary = [
  { idea: "thực thi hình phạt một cách nhất quán", terms: "enforce penalties consistently" },
  { idea: "khiến người có ý định phạm tội cân nhắc hậu quả", terms: "make potential offenders anticipate the consequences" },
  { idea: "răn đe hành vi phạm tội", terms: "deter criminal behaviour" },
  { idea: "đầu tư vào các chương trình việc làm", terms: "invest in employment programmes" },
  { idea: "giải quyết nguyên nhân xã hội gốc rễ", terms: "address the underlying social causes" },
  { idea: "ngăn người dễ bị tổn thương sa vào hoạt động phạm pháp", terms: "prevent vulnerable people from turning to illegal activity" },
];

const topicHistory = [
  {
    commentNumber: 1,
    status: "completed",
    feedback: "**Vấn đề chính:** Topic Sentence mới chỉ nói đến cảnh sát và luật pháp nên chưa bao quát Idea 2 về nguyên nhân xã hội.\n\n**Em hãy tự kiểm tra:** Câu này đã cho người đọc thấy cả hai cách chính phủ phòng chống tội phạm chưa?",
  },
  {
    commentNumber: 2,
    status: "completed",
    feedback: "👍 Đã đạt. Câu thể hiện rõ lập trường, đồng thời bao quát được cả thực thi pháp luật và xử lý nguyên nhân xã hội.",
  },
];

const idea1History = [
  {
    commentNumber: 1,
    status: "completed",
    feedback: "**Mắt xích cần sửa:** X chưa giải thích vì sao quyền kiểm soát luật và cảnh sát lại ngăn được tội phạm.\n\n**Vì sao:** Câu hiện tại nhảy thẳng từ A sang kết quả B.\n\n**Em hãy tự trả lời:** Việc thực thi hình phạt nhất quán thay đổi suy nghĩ của người có ý định phạm tội như thế nào?",
  },
  {
    commentNumber: 2,
    status: "completed",
    feedback: "👍 Đã đạt. X đã giải thích được cơ chế dự đoán hậu quả, nhờ đó B về tác dụng răn đe nối hợp lý với A.",
  },
];

const idea2History = [
  {
    commentNumber: 1,
    status: "completed",
    feedback: "**Mắt xích cần sửa:** X mới khẳng định các chương trình này ‘help people’ nhưng chưa nêu điều kiện nào liên quan đến tội phạm được thay đổi.\n\n**Em hãy tự trả lời:** Giáo dục và việc làm làm giảm những áp lực xã hội cụ thể nào có thể dẫn tới hành vi phạm tội?",
  },
  {
    commentNumber: 2,
    status: "completed",
    feedback: "👍 Đã đạt. Chuỗi A–X–B đã chỉ rõ chính sách làm giảm nghèo đói, sự loại trừ và thiếu cơ hội trước khi chúng dẫn đến tội phạm.",
  },
];

const emptySections = () => ({
  topic_sentence: { status: "draft", comments: [] },
  supporting_idea_1: { status: "draft", comments: [] },
  supporting_idea_2: { status: "draft", comments: [] },
  draft: { status: "draft", comments: [] },
});

const passedPlanningSections = () => ({
  topic_sentence: { status: "passed", comments: topicHistory },
  supporting_idea_1: { status: "passed", comments: idea1History },
  supporting_idea_2: { status: "passed", comments: idea2History },
  draft: { status: "draft", comments: [] },
});

const planningResponses = { ...plan, topic_sentence: passedTopic, ...passedIdea1, ...passedIdea2 };

export const task2DemoScenarios = [
  {
    id: "start",
    shortLabel: "Mới bắt đầu",
    title: "Học viên chưa nhập nội dung",
    description: "Chỉ Bước 1 mở; các phần sau báo rõ phải hoàn thành phần trước.",
    responses: {},
    sections: emptySections(),
    vocabulary: [],
  },
  {
    id: "topic-revision",
    shortLabel: "Topic cần sửa",
    title: "Topic Sentence chưa bao quát hai Idea",
    description: "AI đặt câu hỏi gợi mở; Supporting Idea vẫn bị khóa cho đến khi Topic Sentence đạt.",
    responses: { ...plan, topic_sentence: "The government should stop crime because it has the police and laws." },
    sections: {
      ...emptySections(),
      topic_sentence: { status: "revision", comments: topicHistory.slice(0, 1) },
    },
    vocabulary: [],
  },
  {
    id: "idea1-revision",
    shortLabel: "Idea 1 hổng X",
    title: "Supporting Idea 1 bị nhảy từ A sang B",
    description: "Topic Sentence đã đạt nhưng điểm giữa chưa giải thích cơ chế răn đe.",
    responses: {
      ...plan,
      topic_sentence: passedTopic,
      idea1_a: passedIdea1.idea1_a,
      idea1_x: "Therefore, crime will be reduced.",
      idea1_b: passedIdea1.idea1_b,
    },
    sections: {
      ...emptySections(),
      topic_sentence: { status: "passed", comments: topicHistory },
      supporting_idea_1: { status: "revision", comments: idea1History.slice(0, 1) },
    },
    vocabulary: [],
  },
  {
    id: "idea2-revision",
    shortLabel: "Idea 2 quá chung",
    title: "Supporting Idea 2 chưa chỉ ra nguyên nhân gốc rễ",
    description: "AI chỉ ra mắt xích X còn mơ hồ; bảng từ vựng chưa được mở.",
    responses: {
      ...plan,
      topic_sentence: passedTopic,
      ...passedIdea1,
      idea2_a: passedIdea2.idea2_a,
      idea2_x: "These programmes help people have a better life.",
      idea2_b: passedIdea2.idea2_b,
    },
    sections: {
      ...emptySections(),
      topic_sentence: { status: "passed", comments: topicHistory },
      supporting_idea_1: { status: "passed", comments: idea1History },
      supporting_idea_2: { status: "revision", comments: idea2History.slice(0, 1) },
    },
    vocabulary: [],
  },
  {
    id: "vocabulary-ready",
    shortLabel: "Đã mở từ vựng",
    title: "Cả hai Idea đã đạt",
    description: "Bảng từ vựng xuất hiện ngay trước Draft; học viên chưa viết Draft 1.",
    responses: planningResponses,
    sections: passedPlanningSections(),
    vocabulary,
  },
  {
    id: "draft-writing",
    shortLabel: "Đang viết Draft",
    title: "Draft 1 đã có nội dung, Draft 2 chưa được tạo",
    description: "Nút copy đã sẵn sàng để học viên chuyển nguyên văn Draft 1 xuống rồi tự sửa.",
    responses: { ...planningResponses, draft1 },
    sections: passedPlanningSections(),
    vocabulary,
  },
  {
    id: "draft-queued",
    shortLabel: "Draft đang chấm",
    title: "Học viên vừa gửi Draft 2",
    description: "Bài được khóa tạm thời; giao diện chờ n8n và LMS tạo kết quả từng câu.",
    responses: { ...planningResponses, draft1, draft2 },
    sections: {
      ...passedPlanningSections(),
      draft: {
        status: "queued",
        comments: [{ commentNumber: 1, status: "queued", feedback: "Hệ thống đang chấm từng câu và tạo kết quả…" }],
      },
    },
    vocabulary,
  },
  {
    id: "technical-error",
    shortLabel: "AI lỗi kỹ thuật",
    title: "Lượt chấm Draft tạm thời thất bại",
    description: "Bài vẫn được giữ; học viên thấy đúng Comment lỗi và nút Thử lại.",
    responses: { ...planningResponses, draft1, draft2 },
    sections: {
      ...passedPlanningSections(),
      draft: {
        status: "revision",
        comments: [{ commentNumber: 1, status: "technical_error", feedback: "Tạm thời chưa thể chấm. Hãy nhấn Thử lại.", canRetry: true }],
      },
    },
    vocabulary,
  },
  {
    id: "completed",
    shortLabel: "Hoàn tất",
    title: "Draft đã được chấm từng câu",
    description: "Section bị khóa và kết quả LMS được hiển thị thành các thẻ ngay trong webapp.",
    responses: { ...planningResponses, draft1, draft2 },
    sections: {
      ...passedPlanningSections(),
      draft: {
        status: "passed",
        comments: [{ commentNumber: 1, status: "completed", feedback: "Kết quả chấm từng câu đã sẵn sàng." }],
      },
    },
    vocabulary,
    lmsResponse: {
      essays: [
        {
          id: "task2-demo-sentence-1",
          index: 0,
          content: {
            type: "doc",
            content: [{ type: "paragraph", content: [
              { type: "text", text: "Therefore, effective law enforcement can deter " },
              { type: "text", marks: [{ type: "highlight" }], text: "criminal behaviours" },
              { type: "text", text: " across society." },
            ] }],
          },
          suggestedContent: {
            type: "doc",
            content: [{ type: "paragraph", content: [
              { type: "text", text: "Therefore, effective law enforcement can deter " },
              { type: "text", marks: [{ type: "highlight" }], text: "criminal behaviour" },
              { type: "text", text: " across society." },
            ] }],
          },
          comments: ["**Sửa lỗi ngữ pháp:** *behaviour* thường là danh từ không đếm được khi nói chung về hành vi phạm tội."],
        },
        {
          id: "task2-demo-sentence-2",
          index: 1,
          content: {
            type: "doc",
            content: [{ type: "paragraph", content: [
              { type: "text", text: "By reducing " },
              { type: "text", marks: [{ type: "highlight" }], text: "the deep social reasons of crime" },
              { type: "text", text: ", these measures can prevent vulnerable people from turning to illegal activity." },
            ] }],
          },
          suggestedContent: {
            type: "doc",
            content: [{ type: "paragraph", content: [
              { type: "text", text: "By addressing " },
              { type: "text", marks: [{ type: "highlight" }], text: "the underlying social causes of crime" },
              { type: "text", text: ", these measures can prevent vulnerable people from turning to illegal activity." },
            ] }],
          },
          comments: ["**Dùng collocation sai:** *underlying social causes of crime* là cách diễn đạt tự nhiên và chính xác hơn *deep social reasons of crime*."],
        },
      ],
    },
  },
];

export function task2DemoScenario(id) {
  return task2DemoScenarios.find((scenario) => scenario.id === id) || task2DemoScenarios[1];
}
