# Triển khai và quay lui Handout Writing 67

05/10/2026. Đây là gói đề xuất để review; chưa chạy trên VPS. Chỉ thực hiện các bước thay đổi máy chủ sau khi Đức duyệt gói cụ thể. Không dùng lệnh dựng lại stack Mapping, Progress Log, Term, Speaking hoặc Writing cũ.

## Đích và phạm vi

Đề xuất thư mục triển khai `/opt/izone-handout-writing67`, service/mạng Compose `izone-handout-writing67`, cổng loopback 3187, API `/api/handout67/v1`, database `handout_writing67`, schema `handout67`, role runtime `handout67_runtime`. Các đích này cần kiểm xung đột và tài nguyên trên VPS trước tạo, chưa là inventory đã readback.

Một image digest riêng; private `.env`, rubric mount chỉ đọc và credential n8n riêng. Không dùng `.env` hoặc Dockerfile của hệ khác. PostgreSQL server, VPS, n8n và Cổng AI có thể chung; giới hạn Handout 67 là 0,5 CPU/256 MB, 5 kết nối, 2 lease toàn sản phẩm, một job/execution, AI 180 giây, lease 300 giây, tối đa 3 lỗi kỹ thuật. Giới hạn này chưa thay cho số đo tải máy chủ/quota thật.

## 1. Chuẩn bị chỉ đọc

Ghi snapshot metadata trước: image digest/start time, revision, tên và đích cấu hình của từng consumer cũ; không ghi giá trị secret hoặc bài học viên. Kiểm cổng 3187 còn trống, PostgreSQL/AI/n8n đủ dung lượng và API roster v1 có đúng lớp được phép. Roster cần HTTPS, chỉ GET; adapter không cấp token cho học viên provisional/yêu cầu mã truy cập. Nếu chưa có contract hợp lệ, dừng, không đọc trực tiếp database Mapping hoặc bỏ PIN.

Chuyển rubric Lesson 5 vào file riêng tư đúng sáu mục, giữ luật không viết hộ học viên. Cần rà độc lập B2 so B1, A2/history đúng ý 2 và vocab đúng A/X/B. Không commit rubric, credential, danh sách học viên hoặc private workflow JSON vào repo công khai.

## 2. Database và image riêng

Quản trị tạo role runtime `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`, mật khẩu qua kênh riêng tư; owner/migration dùng tài khoản khác. Tạo database riêng, thu quyền PUBLIC trong database mới, chạy `db/001-initial.sql` qua migration admin đã kiểm đúng database. Sau đó chỉ cấp CONNECT vào database này, USAGE schema handout67, SELECT/INSERT/UPDATE vào hai bảng cho runtime. Runtime không được CREATE/DROP schema, ALTER/DROP bảng hay DELETE bài.

Không sửa quyền PUBLIC của database sản phẩm cũ. PostgreSQL có thể đã cấp quyền PUBLIC ở nơi khác: phải dùng runtime mới thử truy cập các bảng nghiệp vụ của Writing/Mapping/Term/Progress Log và nhận permission denied. Chỉ có tên role/database đúng chưa chứng minh cô lập. Nếu PUBLIC grants làm đọc được hệ khác, không activate; cần phương án hạ tầng/quyền riêng được duyệt thay vì âm thầm sửa quyền hệ cũ.

Lệnh migration có đầu vào `HANDOUT67_MIGRATION_DATABASE_URL`, nhận tài khoản quản trị và database đích, tạo schema/bảng mới; nếu database không đúng thì dừng. Lệnh server không tự migrate. Build chỉ từ thư mục `handout-writing67`, ghi digest sau build và dùng digest đó trong Compose; kiểm `db/001-initial.sql` có trong image, user node, secret/prompt không nằm trong image. Node base đã chọn 24.15.0-alpine3.23; build và vulnerability scan thực tế còn phải kiểm.

Chạy riêng `docker compose -p izone-handout-writing67 config` rồi `up -d handout67` trong đích riêng, sau kiểm config và quyền. Không `down` stack chung. Runtime startup kiểm actual current_database/current_user và bảng trước mở HTTP. Health chỉ kiểm tiến trình sống: cần kiểm session/save/readback riêng để chứng minh đường database.

## 3. Workflow và đường HTTPS

Generator ở repo n8n, thư mục `n8n-workflows/workflows/handout-writing67`, xuất hai candidate inactive. Bind API HTTPS riêng, webhook wake riêng, credential nội bộ riêng, credential wake riêng và gateway đã kiểm. Tạo workflow lỗi trước để gắn ID thật vào workflow chấm; lưu all/all/manual theo quy tắc n8n. Không thay workflow Docs Lesson 5 hoặc nhánh Lesson 7 dùng chung.

Chỉ thêm routing cho API Handout 67 đến loopback 3187; không thay upstream/entrypoint hệ khác. Chạy kiểm cấu hình proxy trước reload có quyền và lưu diff/routing readback. n8n callback URL lấy từ cấu hình đã bind; học viên không điều khiển URL. AI response phải có operation_key đúng job, JSON đúng contract. Backend mới có quyền quyết định mở bước. Notifier gửi metadata mỗi 30 giây khi có queue; nếu mất ACK hoặc n8n lỗi, job vẫn giữ và lease cấp lại có giới hạn.

Test riêng bằng học viên giả và execution ID thật: một grade, một vocab, sai tuple, hết lease, commit mất ACK rồi readback, hai consumer và ba job để chứng minh trần hai lease. Không coi validate/offline contract là execution thành công. Execution phải hoàn tất, callback đọc lại đúng job/hash, UI phải nhìn thấy kết quả mới mới được mở lớp.

## 4. Frontend và canary

Bản demo Pages hiện dùng chấm mô phỏng. Nối API thật bằng base URL đã duyệt, giữ token phiên trong trình duyệt và header, xử lý 409 khi hai tab, trạng thái chờ/kỹ thuật, polling theo phiên. Kiểm xác nhận tên, Topic/history, B1→A1→X1→vocab1 rồi mở ý 2, B2→A2→X2→vocab2. Kiểm nhiều phiên sau cùng proxy; không dùng X-Forwarded-For tự khai để vượt quota.

Mở canary nhỏ sau kiểm native; đọc lại bài và nhận xét đúng học viên. So metadata các consumer cũ trước/sau: image, start time, revision và đích cấu hình phải không đổi. Nếu ảnh hưởng consumer khác, dừng rollout riêng và điều tra. Chốt owner vận hành, quota và ngưỡng job chờ 10 phút; chưa có tự động cảnh báo/dashboard trong candidate. Trước nhiều lớp phải chốt retention/archival với owner, giữ lịch sử và biên nhận idempotency; không tự xóa bài.

## Quay lui

Ghi digest trước và sau mỗi lần phát hành. Nếu bản mới lỗi, chỉ đổi `HANDOUT67_IMAGE` về digest Handout 67 đã kiểm, `up -d handout67`; giữ database, rubric/cấu hình tương thích và bài. Đọc lại session/bài/job sau quay lui. Không restore đè database hoặc xóa schema để rollback code, không chạy migration của Writing/Mapping. Với lần dựng đầu chưa có digest cũ, dừng riêng Handout 67 và khóa route/consumer riêng; Docs vẫn là đường học hiện hành, không tự chép dữ liệu ngược.

## Trạng thái còn mở

Docker/role grants/proxy/AI thật, nguồn roster, chuyển rubric chuyên môn, nối frontend và canary đều chưa có bằng chứng. Candidate local không đủ để gọi production ready hoặc verified. Source và các hướng dẫn mới có thể review trước những bước có quyền riêng này.
