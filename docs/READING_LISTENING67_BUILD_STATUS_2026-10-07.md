# Reading/Listening 67 — dịch vụ database riêng

Đã triển khai luồng nhận bài theo mã và nội dung Docs, giữ ngưỡng hoàn thành 80%, bỏ điều kiện đăng ký Lark. Reading/Listening dùng chung repository và thư viện đã ghim của Writing, nhưng chạy container, database, cấu hình, token và hàng xử lý riêng. Source khởi động Writing không đổi.

## Hành vi

- Nhận file chưa có hồ sơ và tạo lượt trong database trước HTTP 202. File ngoài Classroom được ghi `outside_classroom`; nguồn đến sau được bổ sung liên kết.
- Dưới 80%: cảnh báo web và một paragraph ngay dưới mã bài, 16 pt đậm đỏ, không link: “Chưa làm đủ 80% khối lượng bài. Hãy bổ sung và nhấn chấm bài lại”.
- Đủ bài: xóa cảnh báo của đúng phần, đọc lại nguồn/revision/chỉ số Docs, chấm, ghi feedback và đọc lại kết quả. Nội dung/công thức/CTA khác được bảo vệ.
- Tải lại trang/chờ lâu/mất ACK giữ cùng request/job. Lượt có kết quả ghi chưa rõ cần đối chiếu trước khi thử lại.
- Nguồn Classroom đọc Google trực tiếp, phân trang và ghép đúng Doc/course/work/submission; nhóm tối đa 20 file. Mỗi lượt scan có một owner, từng lớp có trạng thái riêng.

## Source

| File/thư mục | Trách nhiệm |
| --- | --- |
| `backend/src/reading-listening67/` | Cấu hình, quyền DB, lưu hồ sơ/lượt/nguồn, API, cảnh báo Docs, nhịp gọi n8n |
| `backend/scripts/serve-reading-listening67.mjs` | Chỉ khởi động dịch vụ RL, không khởi động server Writing |
| `backend/reading-listening67/` | Image/compose riêng và sao lưu database |
| `backend/reading-listening67-test/` | Môi trường thử riêng, nhịp gọi n8n mặc định tắt |
| `backend/scripts/verify-reading-listening67-postgres.mjs` | Kiểm PostgreSQL nhiều kết nối, chỉ cho database thử |
| `docs/migrations/2026-10-07-reading-listening67-*.sql` | Các SQL tạo phần RL riêng; bản chuẩn nằm trong repo database |
| `backend/test/reading-listening67*.test.js` | Guards, SQL, warning/readback, callback và notifier |

Container RL giới hạn 0,25 CPU/128 MiB; pool 2, tối đa 2 lượt chấm đang giữ quyền. API private có namespace v1, token/parser/quota riêng. Đọc metadata đã xác nhận role không có quyền bảng sản phẩm khác; không dùng trạng thái hoặc quyền dữ liệu Writing.

## Kiểm chứng

Backend: 337/337, không skip. PostgreSQL thật: 50 assertions về concurrency, owner, tỉ lệ 79/80, phase ghi, callback và nguồn. Hợp đồng/Code n8n mới: 21/21. Parser: 12 mẫu qua đủ 11 mã và thêm một biến thể Listening. Native Reading/Listening và vòng bổ sung trên Chrome thật đã ghi/đọc lại thành công; không tuyên bố full-grade AI trên mọi mã.

Image, mốc khởi động và hash cấu hình live Writing/Progress Log giữ nguyên; Writing health 200. Không có lượt điểm danh Portal mới trong phép kiểm này. Danh tính tài liệu, mã lượt, execution, nội dung học viên, snapshot và bằng chứng đầy đủ giữ riêng tư, không lưu trong repo công khai.

## Vận hành và quay lui

Secret cấp ngoài Git. Chuẩn bị database/role riêng rồi áp dụng 6 migration đúng đích. Image nền phải có đúng ID đã ghim; không dùng tag đổi nội dung hoặc đưa cả source Git lên Writing đang chạy.

Các test local nhận fixture giả, kiểm logic/SQL/HTTP và trả lỗi khi bất biến bị phá. Lệnh dưới chạy trong thư mục backend:

```sh
npm test
```

Script PostgreSQL chỉ nhận URL database `reading_listening67_test`, tạo dữ liệu giả và trả báo cáo assertions. Chạy khi môi trường thử đã sẵn sàng; sai database dừng trước kết nối. Không dùng URL production cho script này.

Sao lưu dùng `backup-database.sh`: xuất một snapshot PostgreSQL nhất quán, kiểm archive/checksum và giữ 30 ngày trong thư mục riêng tư. Đã thử restore vào database tạm và đọc lại danh mục, nguồn và các job canary; DB tạm đã dọn. Lịch daily 02:15 giờ Việt Nam được cấu hình ở VPS. Backup hiện ở cùng VPS, chưa xác minh một bản ngoài máy chủ.

Khi sửa lỗi, đọc cùng job/Doc/code/revision và execution owner. `needs_review` không được mở lại bằng phỏng đoán; API đối soát chỉ nhận các proof an toàn đã xác định. Source scan `partial` và CTA `error`/`review` được điều tra riêng, không trở thành gate nhận chấm.

Quay lui chỉ container/workflow RL đã ghim, giữ database/history và đối chiếu lượt có thể đang ghi. Không restart hoặc thay cấu hình Writing. Rà CTA của kho file lịch sử còn chạy nền; không mặc định mọi file lịch sử đã đủ quyền hoặc có CTA hợp lệ.
