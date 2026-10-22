# Reading 67 — lưu và chấm bài web, bản thử chặng 2

Học viên nhập trên web, nháp được lưu lên máy chủ với số phiên bản. Nhấn Chấm bài
tạo một bản gửi riêng; phản hồi luôn thuộc bản đó. Việc sửa nháp trong lúc chấm
không làm thay đổi kết quả cũ. Chặng này chỉ chạy trên máy local, chưa phát hành.

## Thành phần và ranh giới

- `backend/src/reading-listening67/web-grader.js`: đọc workflow private đã ghim hash;
  chạy nguyên các Code node kiểm/gate/deterministic/oracle/prompt/unit audit/merge.
  Adapter web tạo target có ID trực tiếp, không dựng Docs ẩn để chấm.
- `web-store.js`: SQL nháp theo owner/course/code/version, CAS, mutation/request
  chống trùng, bản gửi bất biến, lease và kết quả riêng. Không sửa bảng luồng Docs cũ.
- `web-routes.js`: lấy identity từ middleware, không tin owner trong JSON; chỉ
  trả kết quả cho đúng người. Không có route cấp key/review trước khi có kết quả.
- `backend/scripts/serve-reading67-web-preview.mjs`: entrypoint local, dùng PostgreSQL
  nhúng PGlite trên ổ đĩa, chỉ bind 127.0.0.1. Hai identity A/B là fixture cục bộ.
- `docs/migrations/2026-10-22-reading67-web.sql`: chỉ áp dụng trong DB thử của task.

Không import startup Writing hoặc thay image/env/container Writing, Read/Lis
production. Thư viện giữ nguyên package-lock hiện hành; không thêm dependency.
Không đưa snapshot workflow, key, prompt, nội dung, response AI hoặc DB thử vào Git.

## Vận hành bản thử

Entrypoint nhận đường config riêng. Config chứa mode `local_test`, port, pagesPath,
dataDir, contentPath, graderPath và hash snapshot đã xác minh. Không để secret trong
command line. Lệnh dưới đọc các đường đó, mở máy chủ và kiểm database; lỗi cấu hình,
pin, SQL hoặc model trả lỗi thật thay vì mở phản hồi mô phỏng.

```powershell
# Chỉ chạy local; dùng file cấu hình đã chuẩn bị trong kho riêng của task.
node backend/scripts/serve-reading67-web-preview.mjs '<config-riêng.json>'
```

Config có đường tuyệt đối và mode local_test mới được nhận. Mở `/reading-skills67/?server=1`
hoặc `/reading-skills67/preview.html?server=1`. API ở `/api/reading-skills67`.
`/_preview/session` chỉ tồn tại trong entrypoint thử; không mount nó ở production.

Máy Đức dùng thư mục dependency thử riêng theo đúng hash package-lock khi junction
node_modules cũ thiếu file. Loader thử chỉ đổi nơi resolve thư viện; không sửa/xóa
junction hoặc thư viện của task khác. Khi dependency đầy đủ, source chạy trực tiếp
theo lệnh chuẩn trên, không cần loader riêng máy.

## Quy tắc dữ liệu và xử lý

- Mỗi nháp có owner UUID + course + mã bài + content version; save cần baseRevision.
  Bản cũ nhận 409, giữ bài trên thiết bị; không tự ghi đè người dùng khác/tab khác.
- Save mất ACK retry đúng mutation ID; request ID gửi chấm giữ qua retry. Cùng nội
  dung và grader hash dùng lại lượt chờ/kết quả đã có, không gọi AI thêm.
- 20 target/16 phần tối thiểu và chuẩn hóa lấy từ code live. Thiếu/trùng/sai model,
  unit audit hoặc target set dừng trước lưu phản hồi thành công.
- Bản gửi ghi snapshot, input hash và grader hash. Callback cần lease, operation ID
  và digest của chính bản gửi; kết quả đảo thứ tự không đổi chủ hoặc phủ nháp mới.
- Writer Docs được thay bằng bảng kết quả web. Giữ raw verdict/error/comment,
  `why_official_right`, `next_step` và mẫu đối chiếu; không giả biên nhận đã ghi Docs.
- Provider giữ model/thinking/generation config request của workflow; response đi
  qua chính validator cũ. Metadata chưa xác nhận generation config đã áp dụng phải
  giữ trạng thái chưa xác nhận, không suy từ request gửi đi.

## Giới hạn và lỗi

Một worker thử chỉ giữ một job đang chấm. HTTP gửi chấm trả 202 trước khi AI xong;
provider timeout 650 giây, lease 15 phút. Không gọi AI trong autosave. Timeout không
rõ kết quả được giữ cần đối chiếu; không tự nhân request khi tải lại trang.
Lượt thất bại không có feedback thành công; câu trả lời vẫn ở draft/snapshot.

Kho PGlite là PostgreSQL thật nhúng cho preview/test, chưa chứng minh pool/role/tải
của PostgreSQL VPS. Nhận diện và quyền GV thật, nhiều thiết bị/thu hồi phiên, lease
khi crash giữa call AI và ghi kết quả, triển khai runtime PostgreSQL chuẩn và CTA
thuộc lát tiếp theo. Không dùng 44 ca kiểm SQL/HTTP thay bằng chứng production.
Thu hồi lease hết hạn hiện chạy khi khởi động; chưa có vòng thu hồi định kỳ.

Kết thúc tiến trình local không xóa DB. Bản gửi/kết quả giữ trên ổ đĩa để mở lại.
Chưa có lệnh dọn lịch sử hoặc ghi/xóa Homework trong bản thử này.

## Kiểm

`backend/test/reading67-web.test.js` nhận `READING67_TEST_FIXTURE_DIR` là kho riêng
có snapshot live đã xác minh và `READING67_TEST_DATA_DIR` cho dữ liệu thử trên E.
Không có snapshot thì nhóm integration được đánh dấu skip có chủ đích; không
được gọi đã kiểm bộ chấm live ở môi trường đó. Lần kiểm hiện tại đã cấp fixture,
không skip. Các ca SQL/HTTP dùng dữ liệu người giả, phần worker failure có provider
giả; phép đối chiếu và lượt UI AI thật được lưu riêng cùng báo cáo task.
