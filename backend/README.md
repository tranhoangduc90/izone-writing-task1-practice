# API luyện Writing Task 1

API công khai không trả ERP ID, Google ID, email, prompt chấm hay credential. Sau khi mapping đồng bộ, n8n gọi `SELECT writing_practice.refresh_activity_roster(<activity_id>)`. Hàm này chỉ lấy lớp/mapping đã duyệt và thành viên Classroom `active`, lưu alias ổn định từ UUID công khai vào `activity_roster`.

## Chạy local

1. Áp dụng [migration nền](../docs/migrations/2026-08-13-writing-task1-practice.sql), [migration Draft](../docs/migrations/2026-08-14-add-draft-practice.sql), rồi [migration Lesson 13](../docs/migrations/2026-08-14-add-lesson13-writing-handout.sql) vào PostgreSQL có schema `mapping`.
2. Sao chép `.env.example` thành `.env`; Bearer token nội bộ phải ngẫu nhiên và tối thiểu 32 ký tự. `GOOGLE_CLIENT_ID` dùng để xác thực tài khoản giảng viên đã có trong mapping.
3. Chạy `npm install`, `npm run check`, `npm test`, `npm start`.

`GET /health` chỉ kiểm tra process. `GET /ready` kiểm tra PostgreSQL.

## Contract v1

Nguồn quyết định là [SYSTEM_CONTRACT.md](../docs/SYSTEM_CONTRACT.md). Các endpoint là:

- `GET /api/v1/activities/:slug/roster` trả activity và `classes[{ classRef, className, students[] }]`.
- `POST /api/v1/sessions` nhận `activitySlug`, `classRef`, `studentRef`.
- `GET /api/v1/sessions/:sessionRef` trả `overview`, `body1`, `body2`, `draft1`, `draft2`, `draft2Unlocked`, `draftVersion`, trạng thái section, `failStreak`, Comment và lịch sử attempt.
- `PUT /api/v1/sessions/:sessionRef/draft` nhận `baseVersion`, `requestId`, năm ô viết và trạng thái mở Draft 2; xung đột trả `409` kèm `current` từ server.
- `POST /api/v1/sessions/:sessionRef/checks` nhận `section: overview|outline|draft`, `requestId`, `snapshot`. Draft chỉ được chấm khi Overview và Outline đã đạt, Draft 2 đã mở, hai Draft không trống và bản gửi trùng với bản vừa lưu.
- `GET /api/v1/attempts/:attemptRef` dùng `ETag`/`If-None-Match`.
- `POST /api/v1/attempts/:attemptRef/retry` chỉ mở lại lỗi kỹ thuật khi lượt đó chưa dùng hết ba lần thử.
- API n8n là `/api/v1/internal/grading-jobs/{claim,:jobRef/complete,:jobRef/fail,recover}` với `Authorization: Bearer …`; claim bắt buộc lease 420 giây và không trả tên học viên.

Tối đa bốn job leased toàn hệ thống. `needs_revision` mới tăng `failStreak`; lần 3, 6, 9… trả `supportWarning`. `passed` khóa đúng section và đưa `failStreak` về 0. Endpoint mở lại section yêu cầu Google ID token của giảng viên có quyền toàn hệ thống trong `mapping.reviewer_account` và ghi audit.

## Contract Lesson 13

- `POST /api/v1/lesson-sessions` mở handout đã gán cho học viên.
- `GET /api/v1/lesson-sessions/:sessionRef` trả 18 ô viết, sáu section, Comment và lịch sử Check.
- `PUT /api/v1/lesson-sessions/:sessionRef/responses` lưu bản nháp với `baseVersion` và `requestId`; bản cũ bị từ chối bằng `409`.
- `PUT /api/v1/lesson-sessions/:sessionRef/live` chỉ cập nhật thời điểm hoạt động và ô đang viết, không lưu từng phím bấm.
- `POST /api/v1/lesson-sessions/:sessionRef/checks` tạo đúng một Comment cho section và từ chối section trống hoặc đã đạt.
- `GET /api/v1/admin/live/activities/:slug` yêu cầu Google ID token và trả một bản tổng hợp cả lớp cho dashboard chỉ đọc.
- Claim n8n có thêm `workerPool`. Workflow Task 1 mặc định chỉ lấy `task1`; workflow Lesson 13 chỉ lấy `lesson13`. Cả hai dùng chung giới hạn bốn việc đang chấm.

Seed [Lesson 13 draft](../docs/migrations/2026-08-14-seed-lesson13-young-leaders-draft.sql) cố ý để activity ở trạng thái `draft` và chưa gán lớp. Không đổi thành `active` trước khi test PostgreSQL staging và xác nhận đúng lớp/ngày kết thúc.

## Production

Compose bind cổng localhost, giới hạn 0.5 CPU/256 MB, filesystem read-only, bỏ capabilities và xoay log tối đa 30 MB. Database admin chạy `writing_practice.purge_expired_student_data()` theo lịch; hàm xóa bài/Comment sau ngày kết thúc lớp cộng 180 ngày. Không commit `.env`, token n8n hoặc dữ liệu học viên.
