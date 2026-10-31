# Đường vào đúng chủ Homework — thử Lesson 12 IC2304

Phạm vi bật: Butterflies in Britain, IC2304, đúng Homework Lesson 12 đã đăng ký. Không chuyển các bài hoặc lớp khác sang link cá nhân trong gói này; học viên chưa phải đăng nhập Google.

CTA học viên có `mode=student`, `class=IC2304`, `documentId` của bản sao. Document ID là ngữ cảnh giao bài, không phải credential. API `/entry` tra đúng một binding đã được xác minh qua Classroom, cùng mã/version/lớp/bài giao, rồi kiểm membership hiện hành. Không chọn người theo tên hoặc lấy binding đầu tiên.

Frontend chỉ khôi phục phiên hoặc tự nhận danh tính chung khi khớp chủ/lớp từ máy chủ. Nếu đang nhớ người khác, giữ phiên/nháp cũ cho đến khi người dùng xác nhận đúng tên; không đọc nháp của người được nhớ sai. Header `X-Reading-Homework-Document` kiểm lại chủ ở POST đăng nhập và mọi API bài học viên trước đọc/ghi dữ liệu. Link giảng viên giữ quyền native/SSO và chỉ xem; 401 không được mượn phiên học viên. Nút chuyển giảng viên giữ chủ Docs dù chưa đăng nhập học viên.

Generic URL cũ vẫn dùng nhận diện/membership hiện hành; không thể suy chủ Docs từ URL chung. Việc khớp chủ link ngăn mở nhầm theo bộ nhớ trình duyệt, không thay thế xác thực danh tính người đang dùng máy. Không có migration, reset, chấm lại hoặc thay version bài.

Writer CTA sinh URL riêng theo target đã kiểm, readback URL trả từ status thay vì URL chung. Chỉ requeue CTA cũ khi link chưa đúng; giữ dòng trạng thái, link kết quả, chữ tay, Listening và các vùng khác. Retry cùng target không nhân ghi.

Kiểm: `reading67-owner-entry.test.js`, `reading67-web-entry-routes.test.js`, các ca Homework/CTA/owner/identity hiện hành; frontend `materials-owner-entry-browser.test.mjs`, hồi quy vai trò và SSO. Fixture không thay bằng chứng trên thiết bị thật.

Gói runtime được ghép từ image live, giữ các khác biệt đã phát hành ở ba module; không rebuild toàn backend từ main. Backup, source exact, canary, config và readback riêng tư tại `/opt/izone-reading12-owner-entry-20261031/` và `E:/Codex-Data/qa/reading12-owner-entry-20261031/`. Quay code/config về container trước phát hành; không restore database bài làm hoặc phiên. Nếu quay pilot, đưa CTA về URL tương thích bằng cùng writer rồi đọc lại.
