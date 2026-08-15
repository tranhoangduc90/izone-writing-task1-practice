# Phát hành Draft trả link LMS ngày 2026-08-15

## Hành vi production

- Học viên hoàn thành Draft 1, copy xuống Draft 2, tự sửa rồi gửi chấm từng câu.
- Workflow hàng đợi chuyển bài nội bộ sang **06b. Draft 2 - Task 1**. Không mở thêm webhook công khai.
- Workflow chỉ chấm đúng đề pie chart về Twitter, Facebook và YouTube đã cấu hình. Đề khác dừng an toàn thay vì dùng nhầm dữ liệu.
- LMS trả đúng một link kết quả. API chỉ nhận HTTPS thuộc `practice.izone.edu.vn/shared/writing-essays/`, sau đó khóa section Draft.
- Nhánh Google Docs cũ giữ nguyên.

## Tải và an toàn

- API không áp trần số job `leased`. `maxJobs` chỉ là kích thước một lần lấy hàng đợi; n8n tự điều tiết bằng lịch lấy một job mỗi execution.
- Khóa hàng `FOR UPDATE SKIP LOCKED`, request id duy nhất, lease và retry cùng Comment vẫn được giữ nguyên.
- Workflow chính chờ workflow chấm từng câu hoàn tất nhưng không tự retry toàn bộ workflow con, tránh tạo trùng link LMS.
- Draft dùng lease 1.200 giây. Hai workflow không lưu execution thành công, lỗi hoặc chạy tay vì payload chứa bài viết.
- n8n không restart trong đợt phát hành.

## Kiểm tra đã qua

- API 23/23; frontend 28/28; cấu trúc và bảo mật workflow 13/13.
- Smoke test production dùng bài band 6.0 giả: attempt `completed/passed`, Draft bị khóa, Comment hoàn tất và link LMS trả HTTP 200.
- Session giả và toàn bộ execution chẩn đoán đã được xóa sau kiểm thử.
- GitHub Pages phát hành từ commit `68b659765f46252af1a608ba5af8bb2e53634202` và workflow Actions hoàn tất thành công.
