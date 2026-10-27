# Listening Homework 67 — ứng viên Lesson 2

Đây là source ứng viên, chưa tự xác nhận production đã chuyển. Lesson 2 có 22 mục/30 ý chấm theo V2 đã được Đức duyệt; nội dung/key/rubric/config ở kho private, không đưa lên Pages. Mỗi lesson sau thay cấu hình và pin riêng, dùng chung runtime sản phẩm.

## Ranh giới và cấu hình

- Image/process riêng `listening-homework67-api`, PostgreSQL riêng `listening-homework67-db`, database `listening_homework67`, role ứng dụng `listening_homework67_app`. Khởi động kiểm database/role và không chạy migration production.
- Tái dùng các module transaction/identity/Docs `reading-listening67/web-*` qua tham số có mặc định giữ Reading. Namespace SQL thư viện nằm trong database riêng; không đọc bảng bài làm hoặc chạy server entrypoint sản phẩm khác.
- `private/api` chỉ mount lesson, asset metadata, app DB URL, khóa đọc nguồn quyền/owner, Docs OAuth và khóa CTA. `private/database`/`private/operator` không mount vào API. Credential và init SQL có password chỉ nằm trong kho private.
- Context là API chỉ đọc; admission kiểm UUID approved + ERP/membership/lớp. Mapping Classroom/Google owner được kiểm riêng trước mỗi ghi Docs, không dùng việc thiếu bản giao Homework để từ chối học viên hợp lệ vào bài.
- Phạm vi mở mặc định lấy ERP course_id5, on_going, deleted_at NULL rồi đối chiếu authority. Ngày 27/10 có 10 lớp; IC2314 chưa có hồ sơ approved, không tự phê duyệt thay.
- Nguồn SSO `listeninghomework`, cookie `listening_homework_teacher`, path `/listening-homework67/api/listening-homework67`. Broker dùng role chỉ có quyền bảng phiên trong DB riêng. Giữ broker/store hiện hành và thêm riêng source, không rebuild broker/main cũ hoặc phục hồi đè SQLite phiên.

## Triển khai trong quyền đã duyệt

1. Chụp baseline đúng compose/container/config/nginx/broker/workflow/Worker; khóa revision của CTA workflow đang chạy. Kiểm drift trước mỗi mutation.
2. Tạo image từ Dockerfile này, private DB/role/schema từ gói operator đã review; mount đúng owner/mode để UID node đọc được file API. Không mount thông tin DB owner vào API.
3. Kiểm native PostgreSQL và role bằng DB fixture `listening_homework67_fixture`/role fixture riêng; kiểm read-only teacher, CAS/idempotency/lease, history và outbox. `fixture-service.mjs` chỉ dùng nội bộ, không publish port, student/teacher entry đóng và AI tắt; explicit fixture Docs không giả Classroom submission.
4. Thêm nguồn SSO và network DB riêng, kiểm vai trò thật và logout. Thêm đúng nginx location từ file ứng viên, chạy nginx -t rồi reload trong quyền đã có. Mount prefix của server và proxy phải cùng `/listening-homework67`.
5. Audio: copy MP3 đã duyệt lên Pages và R2 private đúng immutable key/hash; deploy Worker catalog mới sau kiểm drift của Worker. Giữ cấu hình Free/512KiB, secret hiện có và 12 asset cũ. Không bật r2.dev hoặc đổi DNS/Paid. Kiểm full SHA hai nguồn, 401/403, quota/partial fallback và client clock.
6. CTA workflow chỉ thêm nhánh cho **mã67-listening-02 + nhãn luyện tập Listening mới**, giữ trigger/settings/node cũ; dùng credential CTA riêng. Kiểm workflow thử inactive + Docs fixture, execution và readback trước production. Các Docs lịch sử có CTA chấm cũ giữ tuyến cũ; không chạy bù hàng loạt hoặc sửa bài đã nộp.
7. Đọc lại URL/hash/config/runtime, quyền và dữ liệu có trước. Chỉ công nhận các lớp có hồ sơ đủ điều kiện thực sự vào được; lớp chờ hồ sơ vẫn giữ guard và hiển thị trạng thái rõ.

## Quay lui

Dừng route/caller mới trước, quay image/config/asset đúng bước; giữ database mới, các bài đã làm và các liên kết SSO để thu hồi đúng phiên. Quay CTA workflow bằng exact backup nếu không có thay đổi hợp lệ xen kẽ; nếu đã drift phải áp patch hẹp, không ghi đè source task khác. Không restore DB bài làm hoặc broker store cũ, reset/chấm lại hay xóa dữ liệu để quay code. Worker có thể bỏ riêng asset/cờ mới; không đổi các test đang chạy.

## Bằng chứng và giới hạn hiện tại

Source và local fixtures đã kiểm SQL qua PGlite, HTTP/quyền, AI thật trên các ca V2, MP3 đầy đủ trong transport fixture, browser desktop/mobile, SSO core và Google Docs thật bằng explicit test adapter. Chưa xác nhận native PG, Google SSO sản phẩm mới, CDN mới hoặc n8n candidate live cho đến khi gói được phép triển khai và đọc lại. Kho riêng `E:/Codex-Data/listening-homework-lesson2-build-20261027/` giữ config/rubric/receipts; runbook repo điều phối giữ báo cáo không chứa secret.
