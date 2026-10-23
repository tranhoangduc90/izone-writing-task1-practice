# Ghi trạng thái Reading vào đúng ô Homework

Chuẩn được Đức xác nhận ngày 23/10/2026 cho bài Reading tạo sau mốc này: nhãn đúng là **TÌNH TRẠNG NỘP BÀI READING**. Listening giữ nhãn riêng **TÌNH TRẠNG NỘP BÀI THỰC CHIẾN**. Không đổi mẫu Reading sang nhãn Listening để làm bộ ghi cũ chạy được.

## Chọn đúng đích

- Xác minh UUID học viên, lớp, mã bài/version, submission, bản sao Docs và tab theo nguồn quyền hiện hành; không nối bằng tên hoặc chọn tài liệu đầu tiên.
- Xác định cặp CTA–mã bài, rồi chọn ô ngay dưới nhãn Reading trong chính bảng bao quanh mã bài. Bảng CTA lồng không được làm mất ranh giới bảng bài.
- Không tìm ô thay thế ở toàn tab, bảng Reading khác, bảng Listening hoặc bảng con của bài khác trong cùng bảng bọc. Không dùng điều kiện “chỉ còn một ô” để chấp nhận sai kỹ năng.
- Không có đúng một ô phù hợp thì dừng với lỗi rõ như `DOC_STATUS_AMBIGUOUS`; không ghi đè hoặc đánh dấu thành công.
- Nội dung dòng tự động và nhãn ô là hai trường khác nhau. Materials đang giữ tiền tố lịch sử `Reading thực chiến (tự động): ` để tiếp tục quản lý dòng đã ghi; tiền tố này không cho phép chọn ô Listening.

## Ghi và đọc lại

Giữ chữ/link nhập tay và mọi vùng ngoài dòng Reading được quản lý. Khóa revision trước ghi; đọc lại chữ, hyperlink, đúng bảng/ô và vùng cần giữ trước khi báo `verified`. Việc đọc lại phải kiểm kỹ năng và ranh giới đích, không chỉ lặp lại bộ chọn sai rồi thấy cùng dòng chữ.

Nếu trạng thái đã bị ghi nhầm sang Listening, sửa code không tự sửa các job đã `verified`. Khi được phép phục hồi, chuyển đúng dòng và hyperlink sang Reading, chỉ bỏ dòng Reading đã đối chiếu khỏi Listening. Giữ nội dung Listening, attempt, điểm, lượt và timestamp; không chấm/nộp/reset hoặc xếp lại toàn bộ hàng ghi để chữa vị trí.

## Nguồn và test hồi quy

- Materials: [bộ chọn ô và lập yêu cầu ghi](../backend/src/reading-listening67/web-homework-docs.js), [kiểm chủ bản sao](../backend/src/reading-listening67/web-homework-owner.js).
- [Test chọn ô](../backend/test/reading67-web-homework-docs.test.js) dùng nhãn mẫu viết độc lập với hằng production. Giữ các ca Reading–Listening cùng tab, CTA lồng và ô gộp, thiếu/trùng nhãn, bài khác trong cùng bảng bọc, CTA–mã ngoài bảng và dòng cũ còn ghi nhầm.
- [Test hàng ghi](../backend/test/reading67-web-homework.test.js) giữ thứ tự, hai người xen kẽ, mất phản hồi, retry và đúng link attempt; [test owner](../backend/test/reading67-web-homework-owner.test.js) giữ kiểm Classroom/UUID/bản sao.

Mẫu bài mới phải được thử với đúng nhãn **READING** và một bảng Listening bên cạnh. Thử thiếu nhãn trong bảng Reading khi tab vẫn còn một ô trạng thái khác phải trả lỗi. Thiếu Homework thật thì dùng nguồn thử hợp lệ; không nộp/chấm thay học viên để tạo bằng chứng.

## Ranh giới kế thừa

Bản sửa ngày 23/10 đã phát hành riêng Reading Materials, đọc lại hai Docs thật và giữ nguyên bản nộp/kết quả. Source bộ ghi Materials dùng nhãn mới và bỏ cách tìm ô thay thế ngoài bảng bài. Dữ liệu học viên và snapshot riêng không nằm trong repo này.

Reading thực chiến nằm ở repo `izone-classroom-mapping-review`, sản phẩm `products/reading-practice`; Listening là sản phẩm riêng. Những bài cũ đã phát hành có thể còn dùng nhãn thực chiến theo contract cũ. Khi tạo bài Reading mới phải đối chiếu và làm bộ ghi tương ứng hỗ trợ chuẩn **READING** trước khi phát hành mẫu; không coi bản sửa Materials là đã chuyển mọi runtime Reading, và không tự đổi nhãn hàng loạt trên Docs cũ.

Triển khai hoặc quay code phải giữ image live, cấu hình/mount và overlay của đúng sản phẩm. Ghi hướng dẫn hoặc lưu Git không tự cho phép triển khai lại, sửa Docs, giao Classroom hay đổi dữ liệu.
