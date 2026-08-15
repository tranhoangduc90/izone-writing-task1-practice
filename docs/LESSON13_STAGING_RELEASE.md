# Cổng thử nghiệm Lesson 13 — đã hoàn tất

> Ghi chú hiện hành: giới hạn bốn lượt chấm trong bản staging này đã được bỏ khỏi API production. n8n là nơi duy nhất điều tiết tải; `maxJobs` chỉ giới hạn kích thước một lần lấy hàng đợi.

## Trạng thái hiện tại

- Staging PostgreSQL thật đã kiểm thử 40 học viên giả, 18 ô nhập, xung đột phiên bản, chống Check trùng và giới hạn bốn lượt chấm đồng thời.
- Dashboard đã kiểm thử bằng một request tổng hợp cho 40 học viên và sáu section.
- Production đã backup, chạy migration, kiểm thử một lượt chấm Gemini bằng UUID giả rồi xóa dữ liệu thử.
- Activity `writing-lesson13-young-leaders` đã phát hành riêng cho IC2200 với 14 học viên từ mapping đã duyệt.
- Workflow `Chấm handout Writing Lesson 13 trên web` đang hoạt động; workflow Task 1 cũ không bị sửa.

## Thứ tự triển khai an toàn

1. Backup database và xác nhận dung lượng đĩa/log của VPS.
2. Chạy migration Lesson 13 bằng tài khoản migration, không dùng tài khoản API.
3. Chạy seed draft; kiểm tra readback đủ một activity và sáu section.
4. Gán đúng class scope và ngày kết thúc lớp, rồi làm mới roster từ mapping đã duyệt.
5. Thêm bản ghi prompt Lesson 13 vào Redis Prompt Registry bằng quy trình riêng tư; không đưa prompt vào GitHub.
6. Cấu hình Google Client ID công khai cho dashboard và xác nhận tài khoản giảng viên có trong `mapping.reviewer_account`.
7. Deploy API riêng với giới hạn 0,5 CPU/256 MB; kiểm tra `/health` và `/ready`.
8. Tạo workflow n8n ở trạng thái tắt, gắn lại credential Redis và URL Gemini bằng giao diện/credential store của n8n.
9. Chạy payload giả qua đủ sáu section; kiểm tra không có Google Docs/Apps Script và không vượt quá bốn việc đang chấm toàn hệ thống.
10. Chạy thử 40 lượt lưu, 40 lượt Check, xung đột hai tab, worker dừng giữa chừng và dashboard 5 giây.
11. Chỉ sau readback/log đạt mới chuyển activity thành `active`, bật workflow và xuất bản link.

## Thông tin đã chốt khi phát hành

- Lớp: IC2200, ERP class ID `1187`.
- Ngày kết thúc dùng cho chính sách lưu dữ liệu: `2026-12-31`; dữ liệu chi tiết được xóa sau 180 ngày.
- Google OAuth Client ID công khai đã cấu hình cho dashboard; không có client secret trong GitHub.
- Prompt Registry `ielts:writing:lesson13:web:v1` chứa đúng hai prompt Topic Sentence và Supporting Idea theo phiên bản `2026-08-14.1`.

Biên bản đầy đủ: [phát hành production Lesson 13 cho IC2200](PRODUCTION_DEPLOYMENT_2026-08-14_LESSON13_IC2200.md).
