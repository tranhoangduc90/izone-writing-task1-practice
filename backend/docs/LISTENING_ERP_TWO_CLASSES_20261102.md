# Listening Homework: đủ roster ERP của hai lớp mới

Cho IC2340/1333 và IC2353/1345 vào web bằng hồ sơ ERP đang học; giữ ghép Google chờ duyệt và quyền giảng viên.

`erpHomeworkClassIds` là opt-in của dịch vụ Listening Homework, chỉ nhận hai class ID được giao. Adapter đọc snapshot v1 hiện hành và endpoint nguồn chỉ đọc `/v1/homework/erp-students`, ghép bằng UUID + class ID + contact ID + trạng thái. Nguồn này lọc on_going/active tại SQL; lỗi nguồn, trùng khóa hoặc nguồn cũ không được fallback thành quyền hợp lệ. Đánh dấu đủ điều kiện web riêng, không sửa `status` Google. Web identity dùng predicate của adapter khi có; consumer khác giữ approved.

Scandinavian cộng hai lớp vào allowedClassIds và ownerEntry.classes. Giữ nguyên các bài khác, gồm Paper on Public Libraries được phát đồng thời. Snapshot, model/rubric/pin/audio và dữ liệu bài làm không đổi.

Kiểm: hồi quy RED trên adapter cũ, GREEN trên bản sửa; 14 ca Listening và 7 ca identity lân cận đạt. Image ghép live đã kiểm lại pending login/resolve/đọc phiên/thu hồi, giữ observer và tối ưu đang chạy. Source/runtime chưa đồng nhất toàn main nên phát bằng overlay ba module trên đúng image live, không rebuild toàn repository.

Runtime cuối image `3355a37132ea62b0ee4bc81c7b17f72075fedd6a279e57155f4207cb3565be25`. Cấu hình/private backup và container trước bản sửa giữ tại `/opt/izone-homework-erp-20261102`; env/mount/mạng/resource limit giữ nguyên. Năm bài Listening public đều đủ 19 và 18 UUID/tên đúng Portal. Không tạo phiên, phát audio, nộp/chấm thay học viên hoặc thử ghi Docs thật. Ghép Google của 11 hồ sơ vẫn chờ; quyền web không thay quyền Docs.

Quay code/config tương thích, giữ các lesson/bài làm mới; không restore database. Cấu hình cần lấy baseline mới nhất, chỉ bỏ opt-in của task nếu thực sự rollback, không ghi đè toàn config cũ làm mất bài được bổ sung sau.
