# Reading Homework · Athletes and stress

Mã mới `67-reading-athletes-and-stress`, phiên bản `athletes-and-stress-20261030-v1`. Câu 19–22 có đáp án một từ và năm mục keyword/paraphrase/vị trí/dẫn chứng mỗi câu; đoạn A–B có nén hai cấp. Tổng 28 mục chấm, ngưỡng 23/28; ô thái độ câu 20 được lưu nhưng không tính chấm hoặc ngưỡng. Không thêm bài luyện ChatGPT vì tài liệu nguồn không yêu cầu.

Nguồn nội dung: [Google Docs của bài](https://docs.google.com/document/d/1VBkT5OY0RmGdpf6w6fiwZfLoMqSO8XkQQh3fb_GmCsQ/edit?tab=t.0). Bộ chấm lấy qua catalog hiện hành `67-reading-03` → `5kghTUphTSvJ9RgT`, phiên bản `93ccd80c-8f9a-4724-b6bc-990830a5d9f1`, giữ nguyên helper, model, prompt, key/rubric và ID. Web gọi adapter của bộ chấm; không chạy writer Docs của workflow cũ. Snapshot và nội dung private ở `E:/Codex-Data/reading-athletes-stress-20261030/`, không đặt vào Pages.

`web-sentence-grader.js` dùng cơ chế kiểm/bổ sung/review bền của Headings qua loader chung và ghim contract riêng. Version kiểm mới `reading-sentence-validation-20261030-v1`. Store/identity/worker/Docs/SSO native giữ nguyên; hàng xử lý giới hạn code/version, nhận diện và nháp theo chủ/lớp/bài. Bộ tổng kết tách 4 đáp án, 20 mục phân tích và 4 bản nén. Hoàn tất chấm khác với đạt toàn bộ.

Pages tái dùng shell Reading Homework, annotation, lịch sử, dock sửa Trước/Tiếp và giảng viên chỉ xem. Renderer Sentence Completion thêm nội dung riêng; profile `skill-homework`, Source Sans 3, 18px, câu phân cách nhẹ R3, focus navy. Không có Options bank vì đề không có bank; không thêm bank giả.

Metabase ngày 30/10 xác nhận 14 lớp đang học/chờ khai giảng của khóa 67. Nguồn phân quyền hiện nhận 13 lớp; IC2404 chưa có trong nguồn. IC2363 và IC2376 có lớp nhưng roster trống. Candidate mở 13 lớp hợp lệ và ghi riêng mục chờ, không tạo người/lớp giả để vượt quyền.

Kiểm hiện có: adapter đúng snapshot và ngưỡng; bổ sung thiếu giải thích; khóa verdict; sai ID/checkpoint; lưu/nộp/diagnostic/cờ đúng chủ; 20 hành trình UI ở 1440, 1024, 390, 320 và 844×390; 10 ca dashboard GV; ba nhịp chờ nền giữ DOM/cuộn. Local API/SQL/worker đã hoàn tất bằng provider fixture. Canary n8n `3101968` success, đúng mã và `externalWrites:0`; bản production chưa đổi. Biên nhận/log/ảnh ở kho private nói trên. Các kết quả này không chứng minh Google SSO, AI hoặc Homework Docs thật đã đạt.

Phát hành cần gói overlay riêng của Reading Homework, cấu hình bài mới và bổ sung một mã vào node nhận CTA hiện hành. Không migration; giữ các image/mount/env/quyền và kiểm việc đang xử lý trước chuyển. So hash nháp/bài/kết quả trước khi khởi động bản mới. Giữ container, config và DB backup; quay code/config, không restore DB bài làm hoặc chấm lại. Trước triển khai kiểm lại source live để giữ thay đổi của task khác.
