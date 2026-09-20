# Phát hành phiên đăng nhập dài hạn cho dashboard Writing

Ngày phát hành: 20/09/2026.

## Kết quả

- Google credential chỉ dùng một lần để mở phiên; các request sau dùng cookie `HttpOnly` theo path `/writing-api`.
- Phiên được gia hạn khi sử dụng, hết hạn sau 90 ngày không hoạt động hoặc tối đa 365 ngày, và bị thu hồi phía máy chủ khi đăng xuất.
- Request ghi bằng cookie cần đúng origin GitHub Pages và header `x-izone-csrf: 1`.
- Frontend không lưu Google ID token trong `sessionStorage` và không gửi Bearer token trên từng request.

## Production readback

- Source backend: commit `cac240f`; frontend Pages: commit `3fcb4af`.
- Image `izone-writing-practice-api:20260920.1-teacher-session`, image ID bắt đầu bằng `30a6d921`.
- API `/health` và `/ready` đều trả `ok=true`; container healthy, restart count 0, giữ 0,5 CPU và 256 MB RAM.
- Database dùng migration `202609200225` và `202609200226`, backup ID `teacher-session-20260920T030932Z`.
- Ca HTTPS bằng tài khoản QA giả đã khôi phục phiên, nhận cookie đủ `HttpOnly`, `Secure`, `SameSite=None`, `Partitioned`, đăng xuất HTTP 200 và xóa sạch fixture.
- GitHub Pages deployment của commit `3fcb4af` thành công; sáu script dashboard production đều HTTP 200 và đã dùng session client mới.

## Backup và rollback

- Source/Compose API trước phát hành được lưu tại `/opt/backups/teacher-session-20260920/writing-api-backend-before.tgz`; archive đã đọc được.
- Rollback ứng dụng: chạy lại Compose cũ tại `/opt/writing-task1-practice-api/backend/compose.production.yml` với project `backend`. Không xóa bảng phiên; frontend có thể được lùi riêng bằng commit Pages trước đó.
