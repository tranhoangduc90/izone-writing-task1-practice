# Homework của Reading Materials — bản thử riêng

Mã bài: `67-reading-materials-beyond-concrete-matching-information-nen-cap-1`.

Học viên làm và xem phản hồi trên Pages. Homework chỉ nhận CTA, một dòng trạng thái và link giảng viên mở đúng bản nộp. Không sao chép bài làm/phản hồi vào Docs, không nộp Classroom.

## Cách hoạt động

1. Đăng ký CTA nhận Doc ID, Classroom course/work/submission/user và tên lớp. Khóa quản trị nằm trong private mount, không nằm trong Pages.
2. Chủ Homework được xác minh trước đăng ký và trước mỗi lần ghi. Đường Classroom thật dùng mapping V1 còn mới, bài giao đúng buổi, tài liệu `STUDENT_COPY` và attachment đúng submission. Không chọn theo tên hoặc lấy tài liệu đầu.
3. Lưu nháp, nộp, reset và chấm xong ghi sự kiện vào hàng Docs trong cùng transaction SQL. Autosave không chờ Google.
4. Bộ đồng bộ xử lý từng sự kiện theo thứ tự của đúng người/lớp/mã/version. Ghi theo revision và đọc lại trước khi báo đã cập nhật.
5. Chưa có Homework thì chờ và thử lại; lỗi sai chủ, mã, đích hoặc người sửa tay dòng tự động thì dừng ghi. Bài trên web vẫn giữ nguyên.

## Phạm vi bản thử đang dùng

- Runtime, database, role và hàng xử lý riêng; không ghép vào runtime Reading/Writing hiện hành.
- Owner mode `explicit_test_fixture` chỉ nhận hai hồ sơ giả và đúng hai Docs đã ghim. Các lớp/học viên khác không có đích ghi.
- Homework Lesson 78 là số buổi của fixture, không suy từ tên target nội bộ `l10` và không dùng để mở lớp thật.
- Có cả đường resolver Classroom thật trong source, nhưng chưa bật trong cấu hình thử.
- Google của giảng viên dùng nguồn quyền Reading V1. Phiên học viên thử và dữ liệu bài chỉ ở database thử.

## Cấu hình và dữ liệu

Entrypoint riêng: `backend/scripts/serve-reading67-web.mjs`. `homework.enabled` mặc định không bật. Khi bật cần số buổi, Pages base HTTPS, khóa quản trị private, Google auth và cấu hình owner rõ ràng.

Migration thêm hai bảng `web_homework_binding`, `web_homework_job` trong database thử. Đích sau khi xác minh không được chuyển sang người/tài liệu khác. Event key và sequence ngăn tạo dòng đôi; link bản nộp giữ `attemptId`, kể cả khi dùng cache sau reset.

Một bộ đồng bộ, chu kỳ 500 ms, lease 180 giây. Google request tối đa 10 giây; Classroom lookup giới hạn trang/thời gian. Chưa có Homework thử lại sau 300 giây, không bị ngừng sau tám lần. Lỗi khác có backoff, quá tám lần dừng để rà. Không tự sửa dòng người đã thay bằng tay.

## Kiểm thử

Các file `backend/test/reading67-web-homework*.test.js` kiểm cấu trúc Docs, quyền chủ, giao thức CTA, transaction SQL, mất ACK, hai người xen kẽ, callback cũ, chấm lỗi và reset/cache. Google và Classroom trong nhóm này là fixture; không tuyên bố chúng là một lần giao Classroom thật.

Canary riêng dùng API HTTPS/SQL và hai Google Docs thật: kiểm CTA, trạng thái/link, giữ ký tự/style/link nhập tay và bài Reading khác. Các lượt nộp dùng lại phản hồi AI thật đã lưu từ chặng trước, không phát sinh lần gọi AI mới.

Giao diện có trạng thái độc lập cho lưu bài và đồng bộ Homework. Link giảng viên chưa đăng nhập chuyển qua Google và quay về đúng bản nộp; chỉ nhận đường quay lại cùng origin và đúng trang bài. API vẫn kiểm quyền lớp/người/bản nộp.

## Phát hành và quay lại

Quyền hiện tại chỉ cho bản thử. Chưa nối receiver đang nhận hàng giao bài thật; chưa mở lớp. Candidate n8n giữ nguyên 40 node cũ, thêm nhánh có điều kiện theo đúng mã Materials. Chỉ bài có mã mới gọi API riêng; bài cũ đi nguyên luồng cũ.

Trước mở thật phải có metadata buổi/bản mẫu đã xác minh, mapping Classroom thật và phê duyệt cổng phát hành tương ứng. Không suy từ việc hai Docs thử đạt thành đã giao bài cho lớp thật.

Gói triển khai thử giữ snapshot database/config và container trước. Quay lại đúng image/config/mount cũ, giữ database; hai bảng mới có thể để nguyên. Không xóa job hoặc dữ liệu để vượt lỗi. Việc quay lui không tự gỡ CTA/trạng thái đã ghi vào Docs.
