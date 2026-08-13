# Kết quả kiểm thử staging ngày 2026-08-13

## Phạm vi an toàn

- Staging dùng database riêng `writing_practice_staging` và 40 học viên hoàn toàn giả.
- API chỉ mở tại `127.0.0.1:8791`, không thể truy cập trực tiếp từ Internet.
- Container bị giới hạn 0,5 CPU và 256 MB RAM.
- Hai workflow n8n vẫn tắt; GitHub Pages chưa được xuất bản.
- Không đưa prompt, token, email, ERP ID hoặc dữ liệu học viên thật vào GitHub hay log kiểm thử.

## Kết quả luồng nghiệp vụ

| Phép kiểm tra | Kết quả |
|---|---:|
| 20 lần Check đồng thời cùng một phần | 1 `attemptRef` |
| Cảnh báo liên hệ giảng viên | Đúng lần 3, 6, 9 |
| Overview trống | HTTP 400, không tạo job |
| Outline trống hoàn toàn | HTTP 400, không tạo job |
| Tab cũ lưu đè bản mới | HTTP 409 |
| Check phần đã đạt | HTTP 423 |
| Polling không đổi với ETag | HTTP 304 |
| Số job được lease đồng thời | Tối đa 4 |
| Lỗi kỹ thuật | Không tăng chuỗi chưa đạt |

## Kết quả tải 40 học viên

- 40 học viên mở phiên, lưu và Check đồng thời.
- Tổng cộng 100 request: 40 response HTTP 200 và 60 response HTTP 202.
- Thời gian hoàn tất: 2,599 giây.
- Database tạo đúng 40 session, 40 bản lưu, 40 lượt Check và 40 Comment.
- Không còn job ở trạng thái `leased` sau phép thử.
- RAM API tăng từ khoảng 29,9 MB lên 32,9 MB trên giới hạn 256 MB.
- PostgreSQL tăng từ khoảng 80,6 MB lên 81,7 MB; API vẫn trả `/ready` thành công.

## Lỗi staging đã phát hiện và sửa

1. Compose trỏ tới mạng Docker chưa tồn tại; đã đổi sang `mapping-api-net` và `n8n-net` đang dùng trên VPS.
2. Cú pháp `tmpfs` khiến Docker hiểu sai `nodev` thành đường dẫn mount; đã sửa ở cả staging và production.
3. Role API thiếu quyền `USAGE` trên schema `mapping`; migration đã được bổ sung.
4. Service roster lặp nhầm trên gói kết quả PostgreSQL; đã sửa và thêm test hồi quy.

## Cổng còn lại trước production

1. Sao lưu và xác minh bản backup database production.
2. Áp migration production và triển khai API tại cổng localhost 8790 qua Nginx.
3. Thêm hai biến môi trường nội bộ cho n8n; việc này cần bảo trì ngắn để tạo lại container n8n.
4. Chạy một lượt chấm giả qua n8n và Gemini, đọc log đầu cuối.
5. Chọn một đề và một lớp pilot, giữ Google Docs làm phương án quay lại.
6. Chỉ bật workflow mới và xuất bản/chuyển link sau khi Đức duyệt cổng production.
