# API luyện Writing Task 1

API công khai không trả ERP ID, Google ID, email, prompt chấm hay credential. Sau khi mapping đồng bộ, n8n gọi `SELECT writing_practice.refresh_activity_roster(<activity_id>)`. Hàm này lấy lớp/mapping đã duyệt và thành viên Classroom `active`, đồng thời nhận ngoại lệ ERP đã được phê duyệt trong `activity_roster_override`; trình duyệt vẫn chỉ nhận alias ổn định và UUID công khai.

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
- `GET /api/v1/sessions/:sessionRef/teacher-comments` trả comment trực tiếp của giảng viên bằng UUID công khai và hỗ trợ `ETag/304`.
- `POST /api/v1/sessions/:sessionRef/teacher-comments/:threadRef/replies` chỉ cho học viên trả lời; không có endpoint xóa, chấp thuận hoặc ẩn thread.
- API giảng viên dưới `/api/v1/admin/.../teacher-comments` cho mọi tài khoản teacher đã xác minh tạo comment, trả lời và đánh dấu đã xử lý. Trạng thái đã xử lý vẫn luôn được trả về và hiển thị.
- API n8n là `/api/v1/internal/grading-jobs/{claim,:jobRef/complete,:jobRef/fail,recover}` với `Authorization: Bearer …`; claim nhận lease 420 giây, riêng Draft được API gia hạn thành 1.200 giây, và không trả tên học viên. API không áp trần concurrency toàn cục; n8n kiểm soát số lượt chạy đồng thời. `maxJobs` chỉ là kích thước một lần lấy hàng đợi.

`needs_revision` mới tăng `failStreak`; lần 3, 6, 9… trả `supportWarning`. `passed` khóa đúng section và đưa `failStreak` về 0. Riêng Draft chỉ được hoàn tất khi callback chứa link HTTPS đúng host `practice.izone.edu.vn` và đường dẫn `/shared/writing-essays/`; API lưu link vào `result_artifacts` rồi khóa Draft. Endpoint mở lại section yêu cầu Google ID token của giảng viên có quyền toàn hệ thống trong `mapping.reviewer_account` và ghi audit.

## Contract Lesson 13

- `POST /api/v1/lesson-sessions` mở handout đã gán cho học viên.
- `GET /api/v1/lesson-sessions/:sessionRef` trả 18 ô viết, sáu section, Comment và lịch sử Check.
- `PUT /api/v1/lesson-sessions/:sessionRef/responses` lưu bản nháp với `baseVersion` và `requestId`; bản cũ bị từ chối bằng `409`.
- `PUT /api/v1/lesson-sessions/:sessionRef/live` chỉ cập nhật thời điểm hoạt động và ô đang viết, không lưu từng phím bấm.
- `POST /api/v1/lesson-sessions/:sessionRef/checks` tạo đúng một Comment cho section và từ chối section trống hoặc đã đạt.
- `GET /api/v1/admin/live/activities/:slug` yêu cầu Google ID token và trả một bản tổng hợp cả lớp cho dashboard chỉ đọc.
- Claim n8n có thêm `workerPool`. Workflow Task 1 mặc định chỉ lấy `task1`; workflow Lesson 13 chỉ lấy `lesson13`. API tách đúng hàng đợi nhưng không áp trần concurrency; từng workflow n8n tự điều tiết số lượt chạy.

Seed [Lesson 13 draft](../docs/migrations/2026-08-14-seed-lesson13-young-leaders-draft.sql) cố ý để activity ở trạng thái `draft` và chưa gán lớp. Không đổi thành `active` trước khi test PostgreSQL staging và xác nhận đúng lớp/ngày kết thúc.

## Production

Compose bind cổng localhost, giới hạn 0.5 CPU/256 MB, filesystem read-only, bỏ capabilities và xoay log tối đa 30 MB. Database admin chạy `writing_practice.purge_expired_student_data()` theo lịch; hàm xóa bài/Comment sau ngày kết thúc lớp cộng 180 ngày. Không commit `.env`, token n8n hoặc dữ liệu học viên.

### Sửa quyền lưu kết quả ghép hồ sơ

Nếu tìm được hồ sơ khác lớp nhưng bấm Ghép hồ sơ trả lỗi nội bộ, kiểm log API có mã PostgreSQL `42501`. Thao tác ghép cần lưu ngoại lệ danh sách lớp; migration cũ chưa cấp quyền này cho tài khoản API.

Sau khi sao lưu database và quyền hiện tại của bảng, áp dụng [migration quyền ghép](../docs/migrations/2026-09-03-reconciliation-override-permissions.sql) bằng tài khoản quản trị. Migration chỉ cấp quyền đọc/thêm/cập nhật các cột cần thiết của `activity_roster_override`; không cấp quyền xóa hay đọc bảng mapping. Không cần khởi động lại API hoặc n8n. Không đổi trạng thái hồ sơ bằng SQL để bỏ qua thao tác ghép.

Kiểm thử thật: chạy `node integration/reconciliation-permissions-staging.mjs` trong backend dùng database `writing_practice_staging`, đúng tài khoản `writing_practice_api`, và fixture từ `integration/staging-seed.sql`. Script tạo hồ sơ giả trong transaction, gọi HTTP ghép thật ở cả nhánh thêm/cập nhật, kiểm bài giữ nguyên, chỉ còn một thẻ trên dashboard và cả hai mã cùng mở đúng bài; cuối cùng luôn hoàn tác dữ liệu thử. Nếu sai database/quyền, thiếu fixture hoặc kiểm tra thất bại, script dừng với exit code khác 0. Không chạy script trên production.

Để hoàn tác quyền, chỉ thu hồi đúng các quyền cột vừa cấp nếu bản sao lưu xác nhận trước đó chưa có; không thu hồi quyền đã tồn tại của tài khoản và không xóa các hồ sơ đã ghép thành công. Sau triển khai, ghép qua dashboard bằng tài khoản quản trị thật rồi đọc lại trạng thái, liên kết và bài làm.

Nếu quyền đã đủ nhưng vẫn có lỗi `23505` ở chỉ mục `activity_roster_active_alias_idx`, hai hồ sơ có thể trùng tên hiển thị. Dịch vụ phải tắt dòng danh sách của đúng hồ sơ tạm trước khi bật dòng chính thức, trong cùng transaction. Lỗi ở bất kỳ bước sau sẽ hoàn tác cả việc tắt dòng tạm, không để học viên mất khỏi danh sách. Liên kết vẫn dựa trên UUID và lớp, không dựa trên tên. Kiểm thử staging bao gồm cùng/khác tên, thêm/cập nhật ngoại lệ, gửi lại, học viên khác trùng tên và lỗi ở bước audit cuối.
