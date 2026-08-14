# Biên bản phát hành Lesson 13 cho IC2200

## Phạm vi

- Bài: `writing-lesson13-young-leaders`, phiên bản `2026-08-14.1`.
- Lớp duy nhất: IC2200, ERP class ID `1187`.
- Roster tại thời điểm phát hành: 14 học viên đang hoạt động, lấy từ mapping đã duyệt.
- Sáu phần được chấm độc lập: Topic Sentence, Supporting Idea 1 và Supporting Idea 2 cho Body 1 và Body 2.

## Các chốt an toàn đã đạt

- Ổ đĩa VPS còn 27 GB; API giữ giới hạn 0,5 CPU và 256 MB RAM.
- Backup database và mã API được tạo trước khi thay đổi production.
- Migration và seed chạy khi activity còn `draft`; học viên chưa thể truy cập trong lúc kiểm thử.
- Prompt chấm nằm trong Redis Prompt Registry, không nằm trong GitHub hoặc manifest công khai.
- Workflow n8n mới dùng nhóm hàng đợi `lesson13`; workflow Writing Task 1 cũ không nhận nhầm việc.
- Một lượt chấm thật bằng UUID giả đã hoàn tất qua API → n8n → Gemini → PostgreSQL; Comment và feedback được ghi đúng, sau đó dữ liệu giả được xóa.
- Transaction phát hành tự đối chiếu roster materialized với mapping hiện hành và chỉ cho phép đúng một scope IC2200.
- Readback sau phát hành: activity `active`, một lớp, 14 học viên, không còn phiên thử.

## Kiểm thử trước phát hành

- Backend: 16/16 bài kiểm thử đạt.
- Frontend: 17/17 bài kiểm thử đạt.
- Staging PostgreSQL thật: 40 học viên lưu đồng thời, 20 lần Check trùng chỉ tạo một lượt, tối đa bốn lease chấm.
- Dashboard: một request tổng hợp trả đủ 40 phiên giả và sáu section mỗi học viên.
- Kiểm tra bảo mật dependency production: không có lỗ hổng được báo cáo.

## Thành phần production

- API: `writing-task1-practice-api`, healthcheck và database readiness đều đạt.
- Workflow: `Chấm handout Writing Lesson 13 trên web`, ID `HuZoBeWaTi89kafS`.
- Prompt Registry: `ielts:writing:lesson13:web:v1`.
- Trang học viên: `lesson.html?task=writing-lesson13-young-leaders`.
- Trang giảng viên: `teacher.html?task=writing-lesson13-young-leaders`, bắt buộc Google Sign-In và quyền reviewer.

## Khôi phục nếu cần

- Backup production: `/opt/backups/writing-practice/lesson13-production-20260814T041550Z`.
- Cách dừng nhận bài mới: chuyển activity về `draft` hoặc `closed` trong một transaction.
- Cách dừng chấm: tắt riêng workflow ID `HuZoBeWaTi89kafS`; không tắt n8n hoặc workflow Task 1 khác.
- Chỉ khôi phục database từ backup khi migration gây lỗi dữ liệu và sau khi đã dừng riêng API; không rollback toàn bộ n8n.
