// Dữ liệu nhận vào: không có; đây là bài minh hoạ hoàn toàn giả, không chứa dữ liệu học viên.
// Việc chính: cung cấp câu trả lời, lịch sử AI và bảng từ vựng cho trang demo tĩnh.
// Kết quả: giao diện có đủ sáu phần đã đạt, nhiều lượt góp ý và bảng từ vựng cuối bài.
// Khi lỗi: trang demo báo không tải được; hệ thống học viên và database không bị ảnh hưởng.
export const completedLessonDemo = {
  responses: {
    body1_idea1: "Younger leaders are usually more familiar with emerging technology.",
    body1_idea2: "They are often more willing to adopt new working methods.",
    body1_topic: "Younger people can bring important advantages to leadership because they tend to be digitally fluent and open to innovation.",
    body1_support1_a: "Young managers often understand new digital tools better than their older counterparts.",
    body1_support1_x: "This familiarity enables them to identify useful technologies and introduce them into daily operations without a long adjustment period.",
    body1_support1_b: "As a result, their organisations can streamline routine tasks and respond more quickly to changes in the market.",
    body1_support2_a: "They may also be more receptive to unconventional ideas and flexible working practices.",
    body1_support2_x: "Having entered the workforce more recently, they are less attached to established procedures and are more likely to question inefficient routines.",
    body1_support2_b: "This openness can encourage experimentation and help a company develop products or services that meet changing customer expectations.",
    body2_idea1: "Older leaders usually possess deeper professional experience.",
    body2_idea2: "They may have stronger judgement and professional networks.",
    body2_topic: "Nevertheless, older leaders remain valuable because their accumulated experience can support sound decisions and organisational stability.",
    body2_support1_a: "Senior managers have often dealt with a wide range of business problems over many years.",
    body2_support1_x: "They can draw on previous successes and failures when assessing risk, especially during a crisis in which an impulsive decision could be costly.",
    body2_support1_b: "Consequently, an experienced leader may protect the organisation from avoidable mistakes and guide junior employees more effectively.",
    body2_support2_a: "Older executives are also more likely to have established relationships with clients, investors and industry specialists.",
    body2_support2_x: "These long-standing connections can provide reliable information, funding opportunities and cooperation when the organisation faces uncertainty.",
    body2_support2_b: "Therefore, their professional networks can strengthen both the credibility and the long-term resilience of the organisation."
  },
  comments: {
    body1_topic: [
      "### Cần sửa\n- Hai idea đúng hướng nhưng Topic Sentence mới chỉ liệt kê từ khoá.\n- Hãy thể hiện rõ quan hệ: *tuổi trẻ* dẫn đến hai lợi thế nào.",
      "### Tiến bộ\nBạn đã có đủ hai nhánh ý. Cụm **keep up with trends** còn hơi chung; nên thay bằng lợi thế cụ thể về công nghệ và đổi mới.",
      "### Kết quả\n👍 **Đã đạt.** Topic Sentence rõ lập trường, bao quát đúng hai supporting ideas và không đi vào ví dụ quá sớm."
    ],
    body1_support1: [
      "### Cần sửa\nChuỗi A–X–B đang nhảy từ biết công nghệ thẳng sang doanh thu. Hãy thêm một bước giải thích công nghệ cải thiện hoạt động hằng ngày như thế nào.",
      "### Kết quả\n👍 **Đã đạt.** X đã nối hợp lý từ năng lực số sang việc triển khai công cụ; B chốt bằng tốc độ phản ứng của tổ chức."
    ],
    body1_support2: [
      "### Cần sửa\nÝ chính phù hợp nhưng từ **creative** còn rộng. Hãy chỉ ra người trẻ ít gắn với quy trình cũ nên sẵn sàng thử cách làm mới.",
      "### Kết quả\n👍 **Đã đạt.** Mạch giải thích cụ thể, không lặp Supporting Idea 1 và kết quả gắn trực tiếp với nhu cầu khách hàng."
    ],
    body2_topic: [
      "### Cần sửa\nTopic Sentence đã chuyển đúng sang mặt còn lại, nhưng hai idea đang chồng nhau ở từ *experience*. Hãy tách thành kinh nghiệm xử lý vấn đề và mạng lưới quan hệ.",
      "### Tiến bộ\nHai nhánh đã tách rõ. Bạn nên thêm **organisational stability** để câu chủ đề thể hiện giá trị chung của chúng.",
      "### Kết quả\n👍 **Đã đạt.** Câu chủ đề cân bằng lập luận, nêu đúng hai nguồn lợi thế và giữ lập trường nhất quán."
    ],
    body2_support1: [
      "### Cần sửa\nVí dụ khủng hoảng hợp lý nhưng cần làm rõ kinh nghiệm quá khứ giúp đánh giá rủi ro ra sao, thay vì chỉ nói họ 'know more'.",
      "### Kết quả\n👍 **Đã đạt.** A nêu kinh nghiệm, X giải thích cơ chế dùng thành công và thất bại cũ, B chốt đúng lợi ích cho tổ chức."
    ],
    body2_support2: [
      "### Cần sửa\nBạn đã nêu mạng lưới quan hệ nhưng chưa giải thích tổ chức nhận được gì từ mạng lưới đó.",
      "### Kết quả\n👍 **Đã đạt.** Chuỗi A–X–B hoàn chỉnh; các nguồn lực cụ thể dẫn hợp lý tới uy tín và sức chống chịu dài hạn."
    ]
  },
  vocabulary: [
    ["thành thạo công nghệ số", "be digitally fluent / possess strong digital literacy"],
    ["đón nhận cách làm mới", "be receptive to new working methods"],
    ["ít bị ràng buộc bởi quy trình cũ", "be less attached to established procedures"],
    ["tinh giản công việc thường nhật", "streamline routine tasks"],
    ["kinh nghiệm tích luỹ", "accumulated experience"],
    ["đánh giá rủi ro một cách thận trọng", "assess risk with sound judgement"],
    ["mối quan hệ lâu năm", "long-standing professional connections"],
    ["tăng sức chống chịu dài hạn", "strengthen long-term organisational resilience"]
  ]
};
