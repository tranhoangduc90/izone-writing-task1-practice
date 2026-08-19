# Hợp đồng web app luyện Writing Task 2

## Người học nhìn thấy gì

1. Nhập thông điệp chung, Idea 1 và Idea 2 cho cả hai thân bài.
2. Chọn một thân bài để luyện, viết Topic Sentence và sửa theo Comment AI đến khi đạt.
3. Viết A–X–B cho Idea 1, sau đó cho Idea 2. Mỗi phần chỉ mở khi phần trước đã đạt.
4. Khi Topic Sentence và hai Idea đều đạt, bảng từ vựng do AI gợi ý xuất hiện ngay trước Draft.
5. Viết Draft 1, copy xuống Draft 2 để tự sửa, gửi chấm và xem các thẻ nhận xét từng câu ngay trong trang.

Handout Google Docs được cung cấp là bài đã làm của một học viên. Hệ thống chỉ học **thứ tự và loại thao tác**; không dùng đề, Idea, Draft, từ vựng, tên hoặc dữ liệu cá nhân trong tài liệu làm nội dung mặc định.

## Cấu hình một đề mới

- Thêm một manifest từ `writing-task2-practice-template.json` và chỉ đổi `activity.slug`, `contentVersion`, tiêu đề và đề bài. Không tạo HTML/JavaScript mới.
- Tạo activity database ở trạng thái `draft`, đặt `grading_pool='task2'` và trỏ tới bộ prompt Task 2 dùng chung đúng phiên bản trong Prompt Registry.
- Không mở class scope cho đến khi migration, checksum manifest, prompt và workflow kiểm thử đều đã được đọc lại.

## Bốn section

| Section | Nội dung học viên nhập | Điều kiện mở |
| --- | --- | --- |
| `topic_sentence` | kế hoạch hai thân bài, lựa chọn thân bài, Topic Sentence | không |
| `supporting_idea_1` | `idea1_a`, `idea1_x`, `idea1_b` | Topic Sentence đạt |
| `supporting_idea_2` | `idea2_a`, `idea2_x`, `idea2_b` | Topic Sentence và Idea 1 đạt |
| `draft` | `draft1`, `draft2` | cả ba phần trên đạt |

Trình duyệt chỉ khóa để hướng dẫn; API kiểm tra lại điều kiện trong transaction trước khi tạo job. Vì vậy gọi thẳng API cũng không thể bỏ qua thứ tự.

## Mỗi lần Check gọi n8n thế nào

Check lưu bài trước, rồi API tạo một `check_attempt` bất biến. Workflow Task 2 dùng cùng cơ chế hàng đợi của Task 1:

- `/claim` nhận tối đa một job thuộc `workerPool=task2`, kèm `jobRef`, `leaseToken`, section, snapshot, lịch sử Comment và phiên bản prompt.
- Topic Sentence/Idea 1/Idea 2 đọc đúng Prompt Registry, gọi Gemini và hoàn tất với `passed|needs_revision`.
- Khi Idea 2 đạt, workflow kiểm tra JSON rồi lưu `artifacts.vocabulary`; Draft sau đó nhận lại artifact này qua `contextArtifacts`.
- Draft được chuyển nội bộ sang workflow chấm từng câu, tạo LMS, kiểm tra host/link và hoàn tất cùng lease.
- Lỗi kỹ thuật gọi `/fail`; API quản lý tối đa ba lần thử và workflow recovery dùng chung trả lease hết hạn về hàng đợi.

Không có webhook Apps Script/Google Docs trong luồng web mới. Các workflow cũ chỉ là nguồn tham khảo về hợp đồng sư phạm và pipeline LMS.

## Riêng tư và an toàn

- Job n8n không chứa tên, email, ERP ID, Google ID hoặc mã lớp.
- Trình duyệt không nhận prompt chấm, token hoặc credential.
- Workflow không lưu execution payload thành công/lỗi; chỉ giữ trạng thái nghiệp vụ trong database theo chính sách hiện có.
- Activity mẫu luôn ở trạng thái `draft`. Activity public-health chỉ mở cho một lớp và học viên kiểm thử giả; chưa gán lớp học thật.

## Cổng phát hành production

1. Chọn đề Task 2 thật và tạo manifest/activity riêng; không sửa template thành bài đang chạy.
2. Nạp ba prompt, kiểm tra record/version là duy nhất và không còn placeholder.
3. Áp dụng migration trên staging, chạy một ca đạt và một ca cần sửa cho từng section bằng dữ liệu giả.
4. Kiểm tra vocabulary, Draft LMS, retry, lease recovery, dashboard và quyền truy cập.
5. Chỉ activate/publish sau khi Đức duyệt production. Biên bản public-health ngày 20/08/2026 đã qua cổng này bằng dữ liệu giả.
