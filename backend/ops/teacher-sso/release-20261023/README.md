# Phiên giảng viên dùng chung — gói chuyển 23/10/2026

Đức đã duyệt production sau khi bản HTTPS thử riêng qua Google thật, chuyển bảy trang, tải lại, đăng xuất và kiểm quyền. Gói này bổ sung K56 thật/demo, Handout Writing 67 và bốn dashboard Substitute vào phiên chung 90 ngày không hoạt động, tối đa 365 ngày. Các runtime Mapping/Progress/Speaking và Term/K56 không dựng lại.

## Nguồn triển khai

- Broker: `backend/src/teacher-sso/` và `backend/scripts/serve-teacher-sso.mjs`. Giữ khóa HMAC và SQLite đang chạy; bổ sung cấu hình bốn nguồn. Hai K56 chỉ cần quyền các bảng phiên/tài khoản; không có quyền ghi bài hoặc điểm.
- Các file trong `handout/` và `substitute/` là module ghép lên đúng image live trong `baseline.json`. Không dùng toàn bộ main lịch sử để thay Handout hoặc Substitute. Các module khác của image giữ nguyên.
- Handout/Substitute xác minh cookie chung qua `/internal/identity/<product>` bằng khóa riêng trong file chỉ đọc, rồi kiểm lại registry/grant gốc. Endpoint nội bộ bị chặn ở Nginx công khai. Hai biến `*_TEACHER_SSO_URL` và `*_TEACHER_SSO_KEY_FILE` phải cùng có hoặc cùng thiếu.
- Cầu nối nhận cookie K56 và cookie Handout cũ dùng đúng path. Handout cũ chỉ được tiếp nhận sau khi API gốc kiểm chữ ký; cookie đã liên kết với phiên bị thu hồi không được mở lại phiên chung.

Khi phát hành, clone env/mount/quyền/command từ đúng container live đã chụp, thêm riêng hai biến SSO và một file khóa cho consumer. Giữ IP, network alias và port của Handout/Substitute để n8n, API học viên, lời giải, chấm và Portal vẫn trỏ đúng đích. Không chép cấu hình/khóa/dữ liệu học viên vào Git.

## Kiểm và đọc lại

Lõi broker/SQL/HTTP/consumer có 18 ca trên nguồn phát hành. Pages có bộ core và browser, gồm K56 quay trang/khôi phục/logout race và UI desktop/mobile. Bản HTTPS thử dùng Google thật; các ca quyền riêng dùng fixture được ghi rõ. Các module Handout/Substitute đã kiểm trên exact live overlay; hash trong baseline dùng đối chiếu phần không sửa.

Sau chuyển phải kiểm URL chính thức bằng Google thật và phiên đang có, mở đúng lớp/bài được phép, tải lại, chuyển sản phẩm và đăng xuất. Đối chiếu snapshot các bảng nghiệp vụ Handout/Substitute trước–sau, cùng ID/image/config của bốn container được bảo vệ. Phần đăng nhập đạt không thay bằng chứng một lượt chấm/ghi Portal mới.

## Quay lui

Khôi phục consumer/client trước; không phục hồi đè SQLite hoặc database bài làm. Giữ broker biết các nguồn và liên kết mới để thu hồi đúng phiên K56/Handout đã phát sinh. Không chạy lại nguyên broker sáu nguồn cũ trên SQLite có liên kết mới. Container consumer cũ được giữ; quay lại đúng IP/alias/port và mount gốc, không restore dữ liệu bài/điểm cũ đè dữ liệu mới.
