# Reading Materials — sửa bài và báo kết quả Homework

Áp dụng cho Materials to take us beyond concrete. Giữ bộ chấm Read 67, 20 target,
ngưỡng nộp 16/20 và dữ liệu nháp/bản nộp/kết quả cũ. Không có migration hoặc chấm bù.

## Kết quả và hành trình

`web-result-summary.js` đọc 20 target có định danh duy nhất và verdict hợp lệ.
Bốn target `.section` là điểm Matching Information; 16 target còn lại là phần nén.
Partial, incorrect và missing đều cần sửa. Chỉ cả 20 correct mới đạt toàn bộ.
Thiếu/mâu thuẫn dữ liệu trả null; không biến thành 0 điểm hoặc chúc mừng.

API trả `progress` ở bản nộp và lịch sử. Docs dùng cùng bộ tính. Link kết quả gắn
đúng attempt; phiên bản nháp, lần nộp và reset là các khái niệm riêng. Retry cùng
revision dùng cùng attempt; revision/lượt mới không gắn lại link của bản cũ.
Kết quả AI chưa rõ vẫn chặn gọi lặp cho cùng nội dung/bộ chấm.

Học viên nộp, xem số phần cần sửa, nhấn Tôi sẽ sửa rồi nộp lại. Phần đã nhập được
giữ; sửa chữ chỉ đổi nhãn thành chờ chấm. Nhận xét khi sửa luôn chỉ bản nộp trước,
không ghép nội dung nháp mới với nhận xét cũ. Reload khôi phục cả nháp và hướng sửa.

## Vai trò và lịch sử

`autoRole` yêu cầu Pages kiểm phiên Google qua SSO/đường API có quyền trước.
Có cả hai loại phiên ưu tiên giảng viên. Thiếu phiên GV mới dùng nhận diện học viên;
403/lỗi dịch vụ không được đổi thành một phiên thành công. Link có người khác
không dùng attempt đó trong phiên học viên. Token Google không nằm trong URL/storage.

Menu Giảng viên chuyển cách xem bài; Xem như học viên vẫn chỉ đọc. Bản nộp lịch sử
giữ nguyên, có đường tới bản mới hơn và thông báo nháp mới chưa nộp khi phù hợp.

## Làm mới Docs cũ

`backend/scripts/refresh-reading67-progress.mjs` nhận đường cấu hình private và thư
mục bằng chứng tuyệt đối. Chạy mặc định để xem trước; thêm `--apply` để áp dụng đúng
bản đã xem trước. Công cụ giới hạn lớp 1293, đúng mã/version hiện tại và binding có
đích; không tạo attempt, reset hoặc gọi bộ chấm. Scope, sequence và dòng cũ thay đổi
thì dừng. Dòng mới đi qua hàng Docs hiện hành, kiểm owner/revision/readback.

Trước/sau giữ ảnh chụp Docs riêng và fingerprint chữ/hyperlink ngoài dòng quản lý.
Chỉ verified khi đúng ô TÌNH TRẠNG NỘP BÀI READING, đúng link và phần ngoài không đổi.
Chưa verified/blocked phải báo lỗi; không xếp lại mọi job hoặc sửa trạng thái thành đạt.

## Kiểm và quay lui

Nhóm `reading67*.test.js` kiểm SQL/HTTP với snapshot grader riêng đã ghim; Google/AI
trong suite là fixture. Pages có `materials-repair-browser.test.mjs`, nhóm login và
SSO; kiểm 1440/390/320 px, quay lại, nhận xét, hai phiên, sai quyền và link lịch sử.
Các ca hồi quy điểm/Docs và luồng sửa phải thất bại trên nền trước sửa, đạt sau sửa.

Phát hành backend bằng lớp image kế thừa đúng image live, chỉ thay module thuộc
gói này; giữ cấu hình, mount và các runtime khác. Giữ container/image cũ để quay
code. So hash từng bản nộp/kết quả/nháp/lịch sử trước–sau. Không restore database
hoặc phiên cũ để quay code. Dòng Docs đã làm mới là dữ liệu hiện hành, không tự xóa.
