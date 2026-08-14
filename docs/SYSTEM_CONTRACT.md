# Hợp đồng hệ thống Writing Task 1 Practice v1

## Phạm vi

- V1 có `overview`, `outline` và `draft`.
- App công khai cho phép chọn lớp và họ tên; không có đăng nhập học viên.
- Mỗi section có trạng thái, chuỗi chưa đạt và lịch sử Comment riêng.
- Section đã đạt bị khóa; section còn lại tiếp tục hoạt động.

## Dữ liệu công khai

- Activity dùng `slug` ổn định trong URL.
- Trình duyệt chỉ nhận `studentRef`, `sessionRef`, `attemptRef` là UUID công khai.
- Không trả ERP ID, Google ID, email, prompt chấm hoặc credential.
- Nếu trùng tên, API trả alias ổn định đã lưu trong database; không sinh lại theo từng request.

## API học viên

### `GET /api/v1/activities/:slug/roster`

Trả metadata activity, danh sách lớp được giao và roster theo `classRef`.

### `POST /api/v1/sessions`

Nhận `activitySlug`, `classRef`, `studentRef`; tạo hoặc mở lại đúng phiên làm bài.

### `GET /api/v1/sessions/:sessionRef`

Trả draft, `draftVersion`, trạng thái từng section, chuỗi chưa đạt và Comment đã tạo.

### `PUT /api/v1/sessions/:sessionRef/draft`

Nhận `baseVersion`, `requestId`, `overview`, `body1`, `body2`, `draft1`, `draft2`, `draft2Unlocked`. Sai phiên bản trả `409` cùng bản server hiện tại.

### `POST /api/v1/sessions/:sessionRef/checks`

Nhận `section`, `requestId` và snapshot. Cùng `requestId` hoặc đã có lượt đang chạy chỉ trả lại lượt hiện tại, không tạo Gemini call mới.

Với `section=draft`, API yêu cầu Overview và Outline đã đạt, Draft 2 đã được mở, Draft 1/Draft 2 đều có nội dung và snapshot khớp bản vừa lưu. Nếu không đạt điều kiện, API không tạo Comment hay công việc chấm.

### `GET /api/v1/attempts/:attemptRef`

Hỗ trợ `If-None-Match`; chưa đổi trả `304`.

### `POST /api/v1/attempts/:attemptRef/retry`

Đưa lỗi kỹ thuật về hàng đợi trên cùng Comment khi lượt đó chưa dùng hết ba lần thử.

### `POST /api/v1/admin/sessions/:sessionRef/sections/:section/reopen`

Yêu cầu Google ID token của giảng viên có quyền; mở vòng mới và ghi audit, không xóa lịch sử cũ.

## API nội bộ dành cho n8n

Base path: `/api/v1/internal/grading-jobs`. Mọi request dùng Bearer token riêng và không đi qua trình duyệt.

- `POST /claim`: `{ "workerId": "...", "maxJobs": 1, "leaseSeconds": 420 }`.
- `POST /:jobRef/complete`: lease token, `passed|needs_revision`, feedback văn bản.
- `POST /:jobRef/fail`: lease token, mã lỗi và cờ có thể thử lại.
- `POST /recover`: trả công việc hết lease về hàng đợi hoặc đóng sau lần thử thứ ba.

`claim` không chứa tên học viên. Nó trả task, section, snapshot, lịch sử Comment cùng `promptRegistryKey`, `promptRecordId` và `promptVersion` đã ghim cho phiên đó.

Prompt Registry dùng `prompt_overview`, `prompt_outline_body` và `prompt_draft2`. Prompt Draft không được đưa vào GitHub Pages hoặc response công khai.

## Quy tắc đếm và khóa

- Chỉ `needs_revision` hoàn tất mới tăng chuỗi chưa đạt.
- Lượt thứ 3, 6, 9... trả `supportWarning=true`.
- Blank bị chặn, request trùng và lỗi kỹ thuật không tăng chuỗi.
- `passed` đặt `locked=true` cho đúng section và đặt chuỗi về 0.
- Giảng viên mở lại section sẽ tạo một vòng mới nhưng không xóa Comment cũ.

## Lưu bài

- IndexedDB trên máy: debounce khoảng 500 ms.
- Database: khi dirty đủ 10 phút, Save thủ công, Check, Lưu và đóng hoặc gửi nền khi đóng tab.
- Check luôn lưu một snapshot bất biến trước khi tạo job.
- Bản lưu dùng optimistic concurrency; không áp dụng “lần lưu cuối thắng”.

## Quy tắc Draft

- Draft chỉ mở sau khi cả Overview và Outline có trạng thái `passed`.
- Ban đầu chỉ hiện Draft 1. Nút chuyển chỉ mở khi Draft 1 có nội dung có nghĩa.
- Khi bấm chuyển, trình duyệt copy nguyên Draft 1 xuống Draft 2, lưu `draft2Unlocked=true` và mới hiển thị Draft 2.
- Check Draft chấm Draft 2 trong phạm vi Overview + Body 1, nhưng giữ cả Draft 1 trong snapshot để đối chiếu quá trình sửa.
- Section `draft` có trạng thái, chuỗi chưa đạt và timeline Comment riêng.

## Giới hạn tải

- Tối đa bốn job ở trạng thái leased trên toàn hệ thống.
- Polling 2 giây trong 20 giây đầu, 5 giây tới phút thứ hai, sau đó 10 giây.
- Dừng polling khi tab ẩn hoặc khi job kết thúc.
- n8n không giữ execution trong lúc học viên polling; API/PostgreSQL trả trạng thái trực tiếp.
