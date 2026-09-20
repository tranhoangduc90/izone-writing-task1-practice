# Retry đúng bước khi n8n còn lệnh cũ trong hàng

Ngày phát hành: 20/09/2026.

## Tình huống người vận hành nhìn thấy

Khi chạy lại từ một bước trước, một execution cũ của bước sau có thể vẫn đang chờ suất n8n. Nếu execution cũ được chạy sau lệnh retry, nó từng có thể lấy thêm một lượt thử bằng dữ liệu cũ. Bước sau cũng từng giữ dấu đầu vào cũ, nên có thể từ chối thành quả mới của bước trước.

## Cách xử lý hiện hành

- Lệnh bàn giao đã đóng được nhận diện là cũ và kết thúc ngay, không tạo lượt thử.
- Khi retry từ một bước, các bước phía sau được đánh dấu đang chờ đầu vào mới.
- Thành quả mới đầu tiên cập nhật dấu đầu vào; các lượt tiếp theo lại bị khóa để chống ghép nhầm bài.
- Giới hạn ba lượt chỉ tính lỗi thật của đúng bước, không bị tiêu hao bởi execution cũ.

## Kiểm thử và đọc lại production

- Toàn bộ 153 test backend đạt; có ca riêng cho lệnh cũ đã đóng và đầu vào mới sau retry.
- Image production: `izone-writing-practice-api:20260920.5-retry-input-marker`.
- Container `writing-task1-practice-api` healthy, restart count 0; `/health` và `/ready` đều trả `ok=true`.
- Mã nguồn trong container khớp SHA-256 của bản Git đã kiểm.
- Backup trước phát hành: `/opt/backups/writing-task1-practice-api/before-retry-input-marker-20260920T0550Z.tar.gz`.

Tài liệu không chứa dữ liệu học viên, nội dung bài hoặc credential.
