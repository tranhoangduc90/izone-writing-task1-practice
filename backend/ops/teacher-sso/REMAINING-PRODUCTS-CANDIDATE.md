# Bản nối các sản phẩm còn lại — chưa phát hành

Ngày 23/10/2026, Đức yêu cầu kiểm nhóm Mapping/Progress Log/Speaking và Term 67, rồi nối K56, Handout Writing 67 và Substitute. Thiết bị cá nhân là mặc định; giữ 90 ngày, không thêm màn chọn tài khoản. Phát hành phải được duyệt riêng.

## Ranh giới

- `service.js`, `http-app.js`, `consumer.js`, `remote-session.js`: phiên chung và adapter; không đọc/ghi bài, điểm hoặc Portal.
- K56 thật/demo dùng thêm hai nguồn `reviewer`/schema `mapping` với path cookie riêng. Chỉ bổ sung cấu hình/quyền bảng phiên trong SSO; không rebuild K56/Term/Mapping.
- Handout/Substitute dùng consumer xác minh cookie chung trên đường nội bộ có khóa riêng, rồi giữ phân quyền gốc. Google mới kiểm đúng client ID từng sản phẩm tại `/v1/login/:product`; không nhận email/subject tự khai.
- Thêm `HANDOUT67_TEACHER_SSO_URL`, `HANDOUT67_TEACHER_SSO_KEY_FILE` và hai biến cùng nghĩa `SUBSTITUTE_TEACHER_SSO_*`. Chưa bật trên các runtime sản phẩm thật.
- `/internal/identity/:product` không được proxy công khai. Cầu nối Handout cũ cần khóa bootstrap và kiểm chữ ký tại API gốc.

## Không dựng lại từ main lịch sử

Source Handout/Substitute live đang có các bản vá ngoài nền Git của task. Phát hành phải ghép đúng phần xác thực lên exact source live vừa đối chiếu, không thay toàn bộ source bằng main:

- Handout: giữ 13/16 module nguyên byte, sửa ba module HTTP/teacher/server và thêm consumer. Giữ chấm cả chuỗi và xử lý IP proxy.
- Substitute: giữ 32/33 module nguyên byte, sửa riêng server và thêm hai module. Giữ registry/grant, lời giải, lớp, release latch và outbox.

Các file nguồn Handout sửa trong branch cũng bảo vệ cơ chế cũ, nhưng gói phát hành phải dùng patch trên bản live hiện hành. Root Substitute cũng vậy. Không dùng bản source nhánh này để chứng nhận toàn image đang chạy.

## Kiểm và bàn giao

- SSO: `backend/test/teacher-sso*.test.js`; HTTP thật, SQLite/PGlite riêng, Google giả ở ranh giới xác minh.
- Handout: teacher/admin/lesson registry trên exact live overlay, 12 ca đạt.
- Substitute: ba ca xác thực trên exact live overlay; thêm kiểm tương thích source Git.
- Pages: core SSO, Reading → Materials, K56 và UI browser desktop/mobile; kiểm cookie trên kho Chrome, truyền mạng fixture. Chưa thay cho Google/Nginx thật ở ba nhóm mới.

Hồ sơ riêng tư tại `E:/Codex-Data/teacher-sso-all-20261023/`: phương án, kết quả, source live, patch, ảnh, log và script chuẩn bị overlay. Không chép credential/dữ liệu riêng lên Git.

Chat `01a16367-bb6b-7d02-8cfb-fb1910dea3e7` đang sửa nộp/audio Term/Mini. Không sửa các file đó. So lại main/live trước tích hợp; giữ các container Test và cấu hình điểm danh.

## HTTPS thử riêng đã được duyệt và kiểm ngày 23/10

Đường [teacher-login-preview](https://tranhoangduc90.github.io/izone-ai-team-pages/teacher-login-preview/) đã phát qua Pages PR #219. API `/teacher-login-preview-api/` dùng PostgreSQL, SQLite, khóa và cookie riêng `izone_teacher_shared_preview`; không đổi cookie hoặc runtime sản phẩm thật. Broker production vẫn ở revision `8a4c944a14dd047e`.

Source `preview-server.mjs` là điểm khởi động của gói thử, được đóng cùng các module đã ghim. Cấu hình Google/quyền thật chỉ đọc từ file private trên máy chủ. Handout/Substitute giữ mã kiểm quyền gốc; K56 dùng auth/SQL gốc, còn danh sách lớp và kết quả là fixture. Các đường nộp/chấm/AI/Portal bị chặn. Đây không phải API nghiệm thu toàn bộ nghiệp vụ Test.

Đã đăng nhập Google thật khởi đầu từ Handout, K56 và Substitute; chuyển đủ bảy trang, tải lại, đăng xuất và đọc lại SQLite/SQL. Phiên ghi nhớ còn gần 90 ngày, trần gần 365 ngày. Đã kiểm giao diện ở 1440 px và 390 px; chưa kiểm thiết bị iPhone/Safari thật. Chrome extension lỗi điều khiển popup nên phần Google thật thực hiện trong trình duyệt tích hợp; không cài cookie giả hoặc chặn mạng API ở phép kiểm này.

`preview-permissions.mjs` có 15 assertion HTTP đạt trên API HTTPS thật bằng phiên fixture cấp trong runtime riêng: lớp ngoài quyền, tài khoản không có trong registry, sai subject và phiên bị thu hồi đều bị từ chối. Phép kiểm này tách riêng với Google thật trên UI. Chín kiểm HTTP không có phiên/Google giả/origin giả/đường nội bộ cũng đạt.

Đối chiếu từ đầu đợt thử: ID/image của bảy container sản phẩm thật giữ nguyên. Toàn bộ 16 module Handout và 33 module Substitute live giữ nguyên hash. K56/Term đã đổi so với bản audit cũ do đợt phát hành của chat sửa Test trước khi bắt đầu bản HTTPS thử này; phải giữ bản mới đó khi tích hợp. Checkout main Pages local đang bẩn nên được giữ nguyên; main GitHub đã có PR #219 và Pages build đạt.

Gói production vẫn chưa được phát hành. Không mở lớp hoặc giao Homework. Sau khi được duyệt production, kiểm lại nguồn live, ghép adapter K56 và hai consumer, rồi kiểm canary trên chính các URL sản phẩm thật.

## Quay lui

Quay phần consumer/client mới trước, giữ database bài và dữ liệu phiên. Không phục hồi đè SQLite cũ làm sống lại phiên đã thu hồi; nếu quay cả broker cần bản biết các nguồn/link mới, không dùng nguyên cấu hình sáu nguồn cũ.
