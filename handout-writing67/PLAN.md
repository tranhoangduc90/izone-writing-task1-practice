# Backend riêng cho Handout Writing 67

05/10/2026 · kế hoạch nền plan-v2; checkpoint native bên dưới thay thế trạng thái trước triển khai · `controlled`, nghiệm thu `small_complete` cho gói local; production có cổng riêng.

## Kết quả và giới hạn

Một sản phẩm Handout Writing 67, trước mắt Lesson 5, có tiến trình/container, cấu hình, phiên bản, database, tài khoản database, hàng chấm và kiểm thử riêng. Các bài Lesson sau là cấu hình của sản phẩm này. Không sửa server.js, container, database hay workflow Docs đang phục vụ Writing/Progress Log/Term/Speaking; không tự chuyển bài cũ.

Frontend giữ bản mẫu đã kiểm tại Pages. Phần này xây backend và hợp đồng chấm để thay hướng mở rộng Writing API trong plan-v1; UI chấm thật và rollout lớp là lát tích hợp tiếp theo, không dùng mock làm bằng chứng AI thật.

## Module và giao diện

| Module | Sở hữu | Nhận → trả | Phụ thuộc |
| --- | --- | --- | --- |
| Nhận diện | session capability, học viên trong phạm vi | roster API chỉ đọc → lớp/tên; xác nhận → phiên và token | adapter roster version v1 |
| Bài và tiến độ | bài, phiên bản, 7 bước, lịch sử | đọc/lưu/check/mở ý 2 → trạng thái đã commit | kho riêng |
| Hàng chấm | job/snapshot/lease/kết quả/vocab | claim → snapshot; complete → commit và readback | bài và kho riêng |
| Vận hành | cấu hình/container/release boundary | health/status → metadata không bài/token | các module trên |

Kho PostgreSQL có đúng một bảng aggregate phiên trong database `handout_writing67`, schema `handout67`; transaction khóa riêng từng học viên. JSON chứa bài, lịch sử và job cùng phiên, tránh commit bài mà mất job. Không truy cập schema của hệ khác. Code dùng pg 8.22.0 và PGlite 0.5.4 đã có trong sản phẩm Writing; own package lock, không import server hoặc queue Writing. Giữ source trong repo Writing nhưng build context/image riêng. Dùng chung repo không đồng nghĩa cùng bản chạy.

Contract HTTP v1: `/api/handout67/v1/roster`, `/sessions`, `/sessions/:ref`, `/responses`, `/checks`, `/idea2`, `/vocabulary/:idea/retry`; nội bộ `/internal/jobs/claim`, `/internal/jobs/:ref/complete`, `/internal/jobs/:ref`. Token phiên không nằm trên URL, roster không được cấp token. Student chọn tên là xác nhận như Progress Log, không chống chọn hộ; token chỉ bảo vệ phiên đã mở. Mở phiên idempotent theo class/student/activity, không reset tiến độ.

Job chứa productId, sessionRef, jobRef, kind, section, ideaIndex, snapshotHash, promptVersion, operationKey và leaseToken. Callback phải khớp mọi khóa, còn lease và JSON hợp lệ. Grade chỉ nhận passed/needs_revision với feedback tiếng Việt; vocab chỉ nhận A/X/B, mỗi nhóm đúng 2 cụm, tối đa 5 từ. Technical failure không cộng Comment cần sửa. History đúng section; B2 chỉ so B1 đã duyệt. n8n không có quyền mở khóa hay chọn URL callback từ payload học viên.

## Thiết kế vận hành trước build

Đường chính: Pages → API riêng → PostgreSQL riêng → consumer n8n riêng → Cổng AI → callback/API readback → UI. Giả định một lớp 30 người check trong 10 giây, dựa cỡ lớp thường dùng; chưa là số đo production. ACK mục tiêu 3 giây; UI báo chờ, không đợi AI trên HTTP check. Claim đúng 1 job mỗi lượt; trần 2 lease toàn sản phẩm, pool 5 kết nối, body 32 KB, mỗi ô 4.000 ký tự. AI deadline 180 giây; lease 300 giây, retry kỹ thuật tối đa 3; token phiên 12 giờ. Không tăng suất gateway/n8n chung. Tải tăng cần đo trước nâng giới hạn.

Job đã lease chỉ được cấp lại sau hết hạn; operationKey giữ nguyên để gateway chống AI trùng. Kết quả đã commit thì retry đọc kết quả, callback giống hệt không tạo Comment mới; callback khác bị 409. Job quá 3 lỗi vào trạng thái cần kiểm tra; giáo viên/người vận hành xem metadata tuổi job, không ghi bài/token ra log. Vocab lỗi thử lại riêng, không chấm X lại; ý 2 mở được khi ý 1 đạt dù vocab lỗi. Hai tab lưu khác phiên bản trả 409, không mất bản cũ.

Chọn PostgreSQL riêng trên cùng máy chủ là mức tách vận hành đơn giản đáp ứng yêu cầu; không dựng VPS/n8n/gateway mới. Máy chủ chung vẫn có thể hết CPU/RAM/kết nối: container giới hạn 0,5 CPU/256 MB, queue riêng, fail closed khi roster/AI lỗi. Quản trị sản phẩm xem health và hàng chờ; trước production phải chốt người trực, URL roster, quota thật và quan sát canary. Health hiện chỉ báo tiến trình sống, không chứng minh database/AI khỏe; chưa có dashboard hoặc cảnh báo tự động. Tín hiệu n8n gửi mỗi 30 giây, thêm tối đa 30 giây trước claim. Trước mở nhiều lớp phải chốt retention/history và ngưỡng archive; không tự xóa lịch sử học viên. Owner đề xuất là người vận hành Handout 67, cần xác nhận khi duyệt rollout. Không tự gửi thông báo email/Slack.

## Các lát và kiểm

1. S1: contract/plan + DB/runtime riêng → health/session/save có readback. Kiểm quyền/token/phiên bản/khởi động lại; không dùng dữ liệu thật.
2. S2 phụ thuộc S1: 7 bước + job/callback/vocab → toàn hành trình qua HTTP, transaction và readback; kiểm skip bước, hai học viên, trùng/mismatch/stale/lease/retry.
3. S3 phụ thuộc S2: Compose/migration/rollback riêng + hướng dẫn hệ thống → gói có thể review; kiểm release boundary bằng validator và fixture nhận/từ chối shared runtime; full suite local + review độc lập. UI/backend/n8n live chưa hoàn tất thì trạng thái not_ready cho rollout.

Mỗi lát dùng plan-v2, consumes: yêu cầu tách đã được Đức giao và demo đã kiểm; produces: contract/source/test/readback. Đổi contract làm stale các consumer và chứng cứ liên quan. Review Focus: đúng người/ý/snapshot; chặn vượt bước phía server; callback/lease chống trùng; scope database/runtime/release riêng; giữ nguyên hệ cũ.

## Lệnh và đường lui

`npm ci`, `npm test` trong thư mục này; test Node native với PGlite chạy SQL PostgreSQL, thêm kiểm HTTP. Máy này chưa có Docker/PostgreSQL server nên Compose build, role grants thật và Nginx/live n8n phải kiểm trước rollout, không suy từ PGlite thành production verified.

Rollback chỉ chuyển image digest của service handout67, giữ database/volume và bài học viên; không `docker compose down` cả stack chung, không chạy migration của Writing/Mapping. Schema mới additive; không có down migration xóa dữ liệu. Gói chưa chạy production nên không có dữ liệu cần chuyển về Docs.

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
