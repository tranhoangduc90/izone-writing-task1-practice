# Triển khai và quay lui Handout Writing 67

05/10/2026. Gói đề xuất nền đã được Đức duyệt và dựng bản thử riêng; checkpoint cuối file là trạng thái hiện hành. Các mục trước checkpoint giữ thiết kế/baseline trước triển khai. Không dùng lệnh dựng lại stack Mapping, Progress Log, Term, Speaking hoặc Writing cũ.

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

## Checkpoint bản thử đã triển khai — 05/10/2026

Đức đã duyệt dựng và kiểm bản thử riêng trên VPS trong task này. Container Handout 67 chạy tại `/opt/izone-handout-writing67`, loopback 3187, API HTTPS `/api/handout67/v1`, database `handout_writing67`, schema `handout67`, role `handout67_runtime`. Image đã ghim `sha256:44474e9f79f9d14208a542f5e3b4f7969be7822be5f3c987fc693914489bd2d3`, source runtime `a5a1e578f21e69a2c0ae89e5174cb9081f95351e`. Không dùng image/env của sản phẩm khác.

Chỉ lớp giả `handout67-thu` và mười tên giả được phép. Roster thử HTTPS chỉ đọc; chưa nối roster thật và chưa mở lớp thật. Mạng sản phẩm riêng được tạo trước và khai báo external ở Compose live; PostgreSQL thêm kết nối mạng này, không khởi động lại PostgreSQL.

Runtime chỉ SELECT/INSERT/UPDATE hai bảng Handout67, không CREATE/DELETE. Probe SELECT của 243 bảng nghiệp vụ trong ba database cũ đều bị từ chối; quyền ghi nghiệp vụ cũ bằng 0, không có hàm SECURITY DEFINER truy cập được qua quyền schema. Không sửa grant hệ cũ.

Hai workflow mới riêng: `BwQW4QVCkcXufYEN` chấm một bước/từ vựng (bật cho bản thử), `UtnYQTjODNpW5ehE` giữ execution lỗi. Lưu all/all/manual, callback và đọc lại đúng job/hash. Giữ ở trạng thái theo dõi, mốc xem lại 12/10/2026; đây không phải quyền giữ workflow phục vụ lớp thật vô thời hạn. Workflow X Docs đã so lại id/version/nodes/connections/settings/active và không đổi; không sửa các workflow Docs khác.

Rubric riêng tư phiên bản `lesson5-rubric-v3`, mount file chỉ đọc `/opt/izone-handout-writing67/prompts-v3.json`. Feedback mục tiêu 60–90 từ, hướng dẫn tối đa100, backend chặn trên150. Prompt được dựng và lưu cùng job trước ACK: cấp lại không đổi prompt/operation key. Job legacy chưa có prompt cố định bị dừng kỹ thuật và yêu cầu gửi lượt mới; không tráo rubric dưới operation key cũ. Không đưa rubric vào source public/image.

Suite backend hiện tại 21/21, không skip; cùng hai ca prompt pin đã RED trên service nền rồi GREEN. AI thật đã cho 7 bước đạt và hai bộ từ vựng, 11 job gồm các lượt sửa được gắn execution/callback/readback thực. Topic/B1 v2 được giữ qua lần phát hành v3; các lượt tiếp theo dùng v3. Fixture chấm mẫu kiểm vận chuyển không được tính là bằng chứng AI.

Đã kiểm native ba phiên/concurrent claim với trần hai lease, callback sai định danh, mất body ACK sau commit rồi replay/readback, hết lease bằng đồng hồ thật hơn300giây, cấp lại giữ prompt/opkey và một Comment. Chỉ restart container Handout67: payload SQL giữ nguyên, consumer cũ không restart. So 40 container trước/sau: image/start time/restart count/environment hash/port/mount giữ nguyên (mount so theo source–destination, không theo thứ tự mảng). Nginx chỉ thêm include riêng; bỏ include khôi phục byte-for-byte site nền và các site khác không đổi.

Frontend riêng `writing-handouts/lesson5-thu/` nối API thật, demo mô phỏng cũ giữ nguyên. Đã kiểm xác nhận tên, tự lưu, hai tab409, restore chỉ phần chưa lưu, offline giữ nháp, pending khóa, Comment thật và reload, bài hoàn tất cùng hai bảng từ vựng; desktop1440 và mobile390/360 không tràn ngang. Bộ test hồi phục portable8ca có source cùng route. Hồ sơ phát hành route thử chỉ nghiệm thu fixture giả; không thay cổng mở lớp thật trong manifest backend.

Đường lui lần dựng đầu: dừng riêng API/consumer Handout67; giữ database/bài, dùng Docs hiện hành. Các image v2 trước sửa prompt pin không đủ điều kiện rollback v3; không đổi về image đó khi có job v3. Lần phát hành sau chỉ chọn digest/prompt tương thích đã kiểm, đọc lại phiên/job và so consumer cũ. Không xóa schema hoặc restore đè bài để quay lui code. Restart cùng digest hiện tại đã được kiểm; chưa tuyên bố đã kiểm rollback code v3 sang một bản v3 khác.

Trước mở lớp thật còn cần roster/quyền lớp, kiểm tải30 và canary, người trực, quota AI và retention/archival. Không tự xóa lịch sử. Chưa có vulnerability scan image hoặc cảnh báo hàng chờ tự động; không dùng kiểm liveness thay readback nghiệp vụ. Cổng backend giữ `not_ready` cho mở lớp thật. Bộ chứng cứ riêng: `E:/Codex-Data/handout67-isolation-20261005/native/`, các file DB_PROOF, DB_WRITE_PROOF, PIN_IMAGE, NATIVE_TRANSPORT, NATIVE_LEASE, NATIVE_RESTART, N8N_AI_PROOF, ISOLATION_AFTER, NATIVE_ROUTE_PROOF và log browser.

## Production IC2304 · 05/10/2026, cập nhật sau checkpoint thử

Đã mở16học viên IC2304; runtime698c623ea584222aee1029fa8cb34ac8f25ce120, image riêng sha256:0be8599fcc2168eb4bef1f7498e986312433904b21be137a592cecc336d0b886. Trang học viên: https://tranhoangduc90.github.io/izone-ai-team-pages/writing-handouts/lesson5/ ; giảng viên: https://tranhoangduc90.github.io/izone-ai-team-pages/writing-handouts/lesson5/teacher.html . Google thật và cookie reload đã kiểm; ACL3 subject-bound chỉIC2304. Góp ýfixture thấy ởHV, currentAI Topic trả1Comment; canaryhọc viên thật rỗng, không tạo bài giả.

Roster16/ACL3 đăng ký riêng từ nguồn đã duyệt; Đức cập nhật khi lớp đổi người, rà12/10 trước mở thêm lớp. Không tự xóa dữ liệu. Workflow riêng đã chuyển keep.40container cũ vàNginx không đổi. Tải30trên kết nối đã thiết lập đạt; kết nối mới từng10s, chưa cam kếtSLAAI. Bằng chứng riêng tư: E:/Codex-Data/handout67-isolation-20261005/real-class-ic2304-20261005 ; hai cổng cuối pass/verified. Các checkpoint chưa mở lớp ở trên là lịch sử đã được thay bởi checkpoint này.
