# Hướng dẫn cho source Writing và dịch vụ phiên

- Mọi sản phẩm IZONE có giảng viên đăng nhập phải kế thừa [chuẩn phiên dùng chung](https://github.com/tranhoangduc90/izone-ai-team-pages/blob/main/docs/TEACHER_SHARED_LOGIN.md): Google một lần trên cùng trình duyệt, 90 ngày không hoạt động/trần 365 ngày, mở thẳng bài có quyền và đăng xuất chung. Giữ kiểm quyền tài khoản/lớp/bài ở từng API; không tạo hệ đăng nhập riêng từng lesson hoặc lưu Google credential trong browser storage.
- Source broker ở `backend/src/teacher-sso/`; module consumer phát hành theo image ở `backend/ops/teacher-sso/release-20261023/`. Đọc README và baseline trước dựng image; canonical main của một sản phẩm có thể chưa bao gồm toàn bộ sửa live.
- Kiểm origin/path/cookie thực tế, Google thật qua sản phẩm, hết hạn/thu hồi/đổi subject và lỗi dịch vụ. Term 67 dùng origin HTTPS có cổng 18869; không chỉ kiểm URL fixture 443.
- Giữ runtime/dữ liệu riêng của các sản phẩm, cấu hình điểm danh Progress Log, bài/nháp/điểm cũ. Quay code không restore đè database phiên hoặc bài làm.
- Dùng branch/worktree riêng và chỉ phát hành phần đã được cho phép. Chuẩn đăng nhập là yêu cầu sản phẩm, không thêm cổng manifest/checker hoặc tự cấp quyền mở lớp/Git/production.
- Khi tạo/sửa Reading Materials hoặc tuyến ghi Homework Reading, đọc [chuẩn ô trạng thái Reading](docs/READING_HOMEWORK_STATUS.md): nhãn **TÌNH TRẠNG NỘP BÀI READING**, cùng bảng với mã bài; thiếu/mơ hồ thì dừng, không lấy ô Listening hay bảng khác. Giữ riêng contract legacy và runtime Reading thực chiến.
