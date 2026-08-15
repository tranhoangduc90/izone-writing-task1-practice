# Phát hành phần Draft ngày 2026-08-14

> Trạng thái hiện hành: bản feedback trực tiếp này đã được thay bằng bản trả một link LMS ngày 2026-08-15. API production hiện không còn giới hạn bốn job leased; xem `PRODUCTION_DEPLOYMENT_2026-08-15-DRAFT-LMS.md`.

## Kết quả

- Commit phát hành: `a63295801fa07864d5f7e07f7c7dffec51fa001d`.
- Web chính: `https://tranhoangduc90.github.io/izone-writing-task1-practice/?task=pie-app-users-by-age`.
- Trang bài giả: `https://tranhoangduc90.github.io/izone-writing-task1-practice/demo-draft.html`.
- API: container `writing-task1-practice-api`, giới hạn 0,5 CPU và 256 MB RAM, trạng thái healthy.
- Workflow chấm: `xXaidLPKbt9oyc5p`, vẫn active, một lịch 10 giây và tối đa một job mỗi execution.
- Workflow đồng bộ prompt: `BqhKcWFlGTzzVXwq`, vẫn active, Redis key không đổi.
- n8n không restart; `RestartCount=0` và thời điểm bắt đầu container không đổi trong toàn bộ đợt phát hành.

## Backup và khả năng quay lại

- PostgreSQL và release API trước thay đổi: `/opt/backups/writing-practice/draft-release-20260814-001612`.
- Workflow n8n trước thay đổi: thư mục local `output/production-backups/2026-08-14-draft-release`.
- Registry Redis trước Draft: key `ielts:wt1:active_prompt_registry:v1:before-draft:20260814-002125`, tự hết hạn sau 7 ngày.
- Nếu cần quay lại, phục hồi hai workflow từ backup, dùng dump PostgreSQL đã kiểm tra được bằng `pg_restore -l`, đưa API về commit cũ và phát hành lại GitHub Pages từ commit `53580af`.

## Các kiểm tra đã qua

- Unit test web: 14/14; unit test API: 12/12.
- Staging PostgreSQL thật với 40 học viên giả: 20 lần Check liên tiếp chỉ tạo một lượt; cảnh báo đúng lần 3/6/9; tối đa bốn lease; ETag/409/423 đúng hợp đồng.
- Staging Draft: bị chặn trước khi Overview và Outline đạt; job mang đúng Draft 1/2; phần Draft khóa sau khi đạt.
- Production smoke test dùng duy nhất dữ liệu giả: n8n nhận job Draft, Gemini trả feedback `needs_revision`, feedback dài 1.259 ký tự; toàn bộ activity/session/bài giả đã được xóa.
- GitHub Pages chạy test và deploy thành công; bốn trang bài giả trả HTTP 200, Markdown render đúng và không có lỗi console trên desktop.
- Sau phát hành: ổ đĩa 43%, RAM khả dụng 2.334 MB, không có job queued/leased và không còn activity kiểm thử giả.

## Lưu ý bảo mật

- Prompt Draft chỉ nằm trong Lark và Redis; không có trong GitHub Pages.
- Trang demo chỉ có bài giả và feedback đã lọc; không có tên, email, ID học viên, token hoặc metadata dispatcher.
- Workflow Google Docs cũ không bị sửa trong đợt này.
