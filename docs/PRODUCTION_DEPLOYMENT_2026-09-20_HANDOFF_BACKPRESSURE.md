# Chống gửi trùng khi n8n đang đông

Ngày phát hành: 20/09/2026.

## Tình huống người vận hành nhìn thấy

Khi n8n đã dùng hết suất chạy, một bài có thể nằm trong hàng chờ lâu hơn bình thường. Trước bản sửa này, hệ thống cứ 30 giây lại gửi cùng một bàn giao, vì bước tiếp theo chưa kịp mở và xác nhận. Các execution trùng làm hàng đợi dài thêm dù dữ liệu bài không bị ghi trùng.

## Cách xử lý hiện hành

- Bàn giao mới vẫn được gửi ngay, không có giới hạn ba bài.
- Khi n8n đã nhận bàn giao, hệ thống để execution chờ suất chạy và không phát lặp theo nhịp 30 giây.
- Sáu giờ là lớp cứu hộ cuối cho trường hợp bàn giao đã được đánh dấu gửi nhưng execution thật sự bị mất.
- Khi một giai đoạn đã bắt đầu chạy, lease và quy tắc thử tối đa ba lần vẫn giữ nguyên; lỗi sau ba lần vẫn vào danh sách cần kiểm tra.

## Kiểm thử và production readback

- Toàn bộ 151 test backend đạt, gồm ca riêng xác nhận bàn giao đã gửi không còn lịch 30 giây.
- Image production: `izone-writing-practice-api:20260920.3-handoff-backpressure`.
- Container `writing-task1-practice-api` healthy, restart count 0; `/health` và `/ready` đều trả `ok=true`.
- Bài canary giữ `send_count=1` sau nhiều lượt lịch, thay vì tăng liên tục.
- Backup trước phát hành: `/opt/backups/writing-task1-practice-api/before-handoff-backpressure-20260920T0510Z.tar.gz`.

Không có dữ liệu học viên, nội dung bài hoặc credential trong tài liệu này.
