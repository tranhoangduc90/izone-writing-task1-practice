# Web app luyện Writing Task 1

Giao diện GitHub Pages, không dùng framework và không chứa dữ liệu học viên, prompt chấm, credential hay đáp án. Mở `?task=<slug>` để tải `manifests/<slug>.json`; thêm `&version=<phiên-bản>` để tải `manifests/<slug>/<phiên-bản>.json`. Không có query thì dùng `sample-task`.

## Chạy cục bộ

```powershell
cd "E:\Codex-Projects\New project\izone-writing-task1-practice\web"
npm test
npm run check
python -m http.server 8080
```

Sau đó mở `http://localhost:8080/?task=sample-task`. Để chạy được luồng thực tế, đặt URL công khai của API trong `config.json`; file này chỉ là cấu hình công khai, không được chứa credential. Sample manifest cố ý không chứa dữ liệu thật.

Manifest dùng contract `task1-web-manifest-v1` do Content Factory xuất: định danh hoạt động, đề/ảnh, cách đọc dữ liệu, phân tích, routes, vocabulary, chatbot và phiên bản nội dung/prompt. Các route có `recommended: true` luôn hiển thị đầu tiên; từ vựng hiển thị thành bảng hai cột Việt–Anh. Chỉ đưa nội dung có thể công khai vào manifest.

## Luồng người học

1. Chọn lớp, rồi chọn tên từ roster trả về bởi API. Trình duyệt chỉ lưu `classRef`, `studentRef`, `sessionRef`, `attemptRef` công khai.
2. Viết Overview hoặc Outline. Outline gồm hai ô Body 1 và Body 2, nhưng chỉ có một trạng thái và một nút gửi.
3. Bản nháp được ghi IndexedDB sau 500 ms; khi có thay đổi sẽ tự lưu database sau 10 phút, hoặc khi bấm **Lưu ngay**, gửi Check, **Lưu & đóng**, hay rời tab.
4. Một phần đạt sẽ bị khóa. Sau phản hồi cần sửa lần thứ 3, 6, 9…, giao diện hiện cảnh báo hỗ trợ.
5. Sau khi Overview và Outline đạt, học viên viết Draft 1, bấm chuyển để copy xuống Draft 2 rồi tự sửa. Nút **Gửi chấm từng câu** tạo một lượt duy nhất; app chờ link LMS, hiện trong một ô kết quả và khóa Draft khi link hợp lệ xuất hiện.
6. Comment trực tiếp của giảng viên xuất hiện trong khung riêng dưới đúng ô viết, có highlight đoạn được nhận xét và thread trả lời. Học viên không có nút xóa, chấp thuận hoặc ẩn comment; trạng thái “đã xử lý” vẫn giữ toàn bộ lịch sử.

## Adapter API

Mọi chi tiết API nằm trong [js/api.js](js/api.js). Adapter hiện gọi hợp đồng v1:

- `GET /api/v1/activities/:slug/roster`
- `POST /api/v1/sessions` với `activitySlug`, `classRef`, `studentRef`
- `GET /api/v1/sessions/:sessionRef`
- `PUT /api/v1/sessions/:sessionRef/draft` với optimistic concurrency (`baseVersion`, `If-Match`) và `requestId`
- `POST /api/v1/sessions/:sessionRef/checks`
- `GET /api/v1/attempts/:attemptRef` với `ETag`/`If-None-Match`
- `POST /api/v1/attempts/:attemptRef/retry` cho lỗi kỹ thuật còn trong giới hạn ba lần

`409` dừng lưu và yêu cầu tải bản server mới nhất; bản IndexedDB không bị xóa. Polling chỉ chạy cho lượt đang chấm, dừng khi tab ẩn, và dùng 2 giây trong 20 giây đầu, 5 giây tới phút thứ hai, rồi 10 giây.

Link kết quả Draft chỉ được render nếu dùng HTTPS, đúng host `practice.izone.edu.vn` và đúng đường dẫn `/shared/writing-essays/`. API và workflow n8n lặp lại cùng kiểm tra trước khi khóa bài.

## Lưu ý triển khai

`fetch(..., { keepalive: true })` chỉ là phương án dự phòng khi đóng tab; API vẫn áp dụng cùng kiểm tra phiên bản/idempotency như `PUT draft`. GitHub Pages không bảo vệ API: backend vẫn phải kiểm tra UUID, CORS origin allow-list và rate limit.
