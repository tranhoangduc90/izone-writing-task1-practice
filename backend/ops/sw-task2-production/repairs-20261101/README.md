# Sửa lượt Draft SW ngày 01/11/2026

Hai sửa hẹp đã được áp dụng theo yêu cầu cứu bài production của Đức:

- `repeated-span.patch`: đối chiếu các vị trí xuất hiện của cùng cụm từ với phần câu sửa phía trước; vẫn kiểm đầy đủ toàn bộ thay đổi và từng lý do. Đã sửa đúng 14 Code node của workflow SW Draft `bEcyXv7COYsWOVH4`; giữ ID node, connections, settings và trạng thái inactive của subworkflow.
- `structured-reason.patch`: giữ nguyên lời giải thích ở payload có cấu trúc, vẫn làm sạch HTML. Không chạy bộ đổi xưng hô lên lời giải thích đã đóng băng vì nó từng xóa nhầm từ “cô” trong “cô lập”. Luồng nhập văn bản legacy giữ nguyên.

Bằng chứng: validator thật RED trên phản hồi lịch sử, GREEN trên bản sửa; các ca từ lặp và thay đổi không được giải thích; 14 Code node qua compile. Canary chạy parser của image mới bằng payload đã lưu, giữ đúng lời giải thích. Validator CLI còn cảnh báo E040/E064 có sẵn; không ghi toàn bộ validator xanh.

Writer mới `sha256:6fa545962b73f74c8f6456ba0eccaafa932c2210b3ab901a91d8381ee06191d8`; bản trước giữ tại `shops-writing-writer-before-reason-20261101`. Mount kết quả, env, hai network, giới hạn bộ nhớ và read-only rootfs giữ nguyên. API/DB/worker không rebuild. Nguồn dựng và bản chụp cấu hình riêng tại `/opt/izone-shops-writing/releases/20261101-reason-preservation`.

Đã cứu thành công một lượt Draft được Đức chỉ định: snapshot nguyên vẹn, hoàn tất và HTTPS đọc lại đủ 5 thẻ với readbackOk=true. Không tự cứu hàng loạt lượt lỗi khác. Một bài khác còn phản hồi gộp nhiều sửa trong một issue: replay vẫn bị từ chối sau sửa từ lặp; giữ là tình huống cần xử lý riêng, không hạ kiểm chứng để ép đạt.

Kho bằng chứng riêng: `E:/Codex-Private/sw-cs181026-vietanh-20261101/`, gồm workflow trước/candidate/sau, execution lịch sử, writer parser trước/sau, canary và receipt triển khai, kết quả đọc HTTPS. Không đưa bài học viên, capability kết quả, environment hoặc credential vào Git.

Quay lui bằng đúng snapshot workflow trước sửa và container writer trước sửa; giữ DB, bài mới và kết quả đã lưu. Không restore dữ liệu để quay code.
