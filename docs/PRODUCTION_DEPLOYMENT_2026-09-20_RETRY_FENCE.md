# Retry đúng bước và giữ hàng nhận nguồn trong sức chứa của n8n

Ngày phát hành: 20/09/2026.

## Tình huống người vận hành nhìn thấy

Khi chạy lại từ một bước trước, một execution cũ của bước sau có thể vẫn đang chờ suất n8n. Nếu execution cũ được chạy sau lệnh retry, nó từng có thể lấy thêm một lượt thử bằng dữ liệu cũ. Bước sau cũng từng giữ dấu đầu vào cũ, nên có thể từ chối thành quả mới của bước trước.

## Cách xử lý hiện hành

- Lệnh bàn giao đã đóng được nhận diện là cũ và kết thúc ngay, không tạo lượt thử.
- Khi retry từ một bước, các bước phía sau được đánh dấu đang chờ đầu vào mới.
- Thành quả mới đầu tiên cập nhật dấu đầu vào; các lượt tiếp theo lại bị khóa để chống ghép nhầm bài.
- Giới hạn ba lượt chỉ tính lỗi thật của đúng bước, không bị tiêu hao bởi execution cũ.
- Một nguồn đã giao cho n8n chỉ được gửi lại sau sáu giờ nếu chưa có xác nhận. Khoảng chờ này là đường cứu cuối, không phải lịch gửi lặp.
- Backend chỉ giao thêm nguồn khi số nguồn vừa giao nhưng chưa được xác nhận còn dưới 100. Workflow theo phút có thể nhận phần sức chứa còn trống, tối đa 100 nguồn trong một lượt; đây là điều tiết đầu vào Google Classroom, không giới hạn số bài AI được chấm đồng thời.
- Khi hàng n8n đang đầy, nguồn mới vẫn được giữ nguyên ở trạng thái chờ trong database. Workflow theo phút tự nhận tiếp khi có chỗ, nên người vận hành không cần bấm lại.
- `FETCH_FAILED` và thiếu metadata do lỗi kỹ thuật được đưa lại vào hàng sau 30 rồi 60 giây; chỉ sau lần đọc thứ ba vẫn lỗi mới chuyển sang **Cần kiểm tra**. Lỗi đề, bảng và định dạng thật không lặp vô ích.
- Khi một lượt đọc sau đã thành công hoặc xác nhận lỗi nguồn thật, cảnh báo kỹ thuật cũ được đóng lại để dashboard không tiếp tục báo một lỗi đã hết.

## Kiểm thử và đọc lại production

- Toàn bộ 155 test backend đạt; có ca riêng cho lệnh cũ đã đóng, đầu vào mới sau retry, chống gửi lặp nguồn, ngưỡng sức chứa của hàng n8n và ba lượt đọc nguồn kỹ thuật.
- Image production: `izone-writing-practice-api:20260920.9-source-retry`.
- Container `writing-task1-practice-api` healthy, restart count 0; `/health` và `/ready` đều trả `ok=true`.
- Bản phát hành cuối được dựng từ source đã qua bộ test nêu trên; readback container xác nhận đúng image và không có lần restart.
- Các mốc backup trước phát hành gồm bản trước khóa retry, trước dấu đầu vào mới, trước chống gửi lặp nguồn và trước ngưỡng sức chứa. Đường dẫn chi tiết nằm trong nhật ký triển khai riêng tư, không đưa vào hướng dẫn thao tác hằng ngày.

Tài liệu không chứa dữ liệu học viên, nội dung bài hoặc credential.
