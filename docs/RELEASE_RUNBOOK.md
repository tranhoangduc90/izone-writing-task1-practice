# Quy trình đưa Writing Task 1 Practice lên môi trường thật

## Cổng 0 — Dung lượng VPS

Production chỉ được bắt đầu khi ổ hệ thống còn tối thiểu 12 GB hoặc mức sử dụng dưới 75%. Không xóa dữ liệu để đạt ngưỡng nếu chưa xác định chính xác nguồn và phương án phục hồi.

## Cổng 1 — Database

1. Backup PostgreSQL mapping và kiểm tra file backup đọc được.
2. Tạo user `writing_practice_api` theo quyền tối thiểu.
3. Chạy migration trong transaction ở database staging.
4. Kiểm tra index, constraint idempotency, constraint một active attempt và truy vấn retention.
5. Chỉ sau kiểm thử staging mới lên lịch maintenance production.

## Cổng 2 — API

1. Build image từ commit đã qua CI.
2. Tạo network riêng để API chỉ kết nối PostgreSQL; cổng chỉ bind `127.0.0.1`.
3. Đặt credential trong file `.env` chỉ root đọc; không đưa vào Git hoặc lệnh chat.
4. Cấu hình Nginx HTTPS `/writing-api/`, CORS chỉ GitHub Pages chính thức.
5. Đặt `GOOGLE_CLIENT_ID` đúng OAuth client đang dùng cho tài khoản giảng viên; không đưa ID token vào cấu hình hay log.
6. Xác nhận `/health`, `/ready`, log rotation, 0,5 CPU và 256 MB RAM.

## Cổng 3 — n8n

1. Workflow vẫn inactive khi cấu hình URL/token nội bộ.
2. Validate local JSON và live readback.
3. Chạy Manual test bằng dữ liệu giả, không dùng dữ liệu học viên thật.
4. Kiểm tra Prompt Registry, Gemini Hub, pass marker và nhánh lỗi kỹ thuật.
5. Với Draft, kiểm tra lời gọi workflow nội bộ, credential LMS trong kho credential, allow-list link kết quả và callback về đúng lease. Không lưu execution thành công/lỗi vì payload chứa bài viết.
6. Xác nhận API không áp trần số job leased; `maxJobs` chỉ giới hạn kích thước một lần lấy hàng đợi và n8n là nơi duy nhất điều tiết concurrency.
7. Chỉ bật Schedule/webhook sau khi được phê duyệt riêng.

## Cổng 4 — GitHub Pages

1. Manifest mẫu và UI không chứa prompt chấm, roster, bài làm hoặc credential.
2. CI phải qua test backend, frontend và kiểm tra schema manifest.
3. Tạo repo public và bật Pages từ GitHub Actions.
4. Cập nhật `web/config.json` bằng URL API công khai; đây không phải nơi đặt token.
5. Kiểm tra URL chính thức trên desktop và điện thoại.

## Pilot

- Một đề, một lớp, giữ link Google Docs cũ.
- Theo dõi: thời gian hàng đợi, lỗi kỹ thuật, số job leased, CPU/RAM, disk, xung đột bản lưu và phục hồi IndexedDB.
- API không giữ trần số lượt chấm đồng thời; n8n là nơi duy nhất kiểm soát concurrency để tránh hai lớp giới hạn chồng lên nhau.
- Kết thúc pilot mới cập nhật `Đường dẫn luyện tập` trong Lark.

## Rollback

- Tắt hai workflow mới.
- Trả link học viên về Google Docs cũ.
- Giữ API/database chỉ đọc để đối soát; không xóa ngay dữ liệu pilot.
- Khôi phục schema hoặc image API chỉ khi đã có backup và lý do rõ ràng.
