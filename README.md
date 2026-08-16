# IZONE Writing Task 1 Practice

Web app luyện **Overview**, **Outline hai thân bài** và **Draft 1 → Draft 2** không phụ thuộc Google Docs.

Repo cũng có bản nháp **Writing trên lớp 67 – Lesson 13**, gộp hai handout Body 1 và Body 2 thành một trang với sáu phần được chấm độc lập.

## Cấu trúc

- `web/`: giao diện tĩnh dành cho GitHub Pages. Không chứa prompt chấm, danh sách học viên hoặc credential.
- `backend/`: API Express và PostgreSQL cho roster, tiến độ, Comment, hàng đợi chấm và chống gửi trùng.
- `docs/`: migration, hợp đồng dữ liệu và hướng dẫn vận hành.
- Workflow n8n và đặc tả được lưu trong kho n8n trung tâm; repo này chỉ giữ hợp đồng tích hợp.

## Dòng dữ liệu

1. Học viên mở `?task=<mã-đề>`, chọn lớp và họ tên.
2. Trình duyệt lưu dự phòng cục bộ sau khi ngừng gõ; API chỉ nhận bản lưu định kỳ hoặc chủ động.
3. Draft 2 chỉ mở sau khi Overview/Outline đã đạt và Draft 1 có nội dung; hệ thống copy Draft 1 xuống để học viên tự sửa.
4. Khi Check, API tạo đúng một Comment và một công việc chấm trong cùng transaction.
5. Overview/Outline dùng Prompt Registry + Gemini Hub. Draft dùng workflow chấm từng câu hiện có; khi LMS tạo xong trang kết quả, app hiện một link duy nhất và khóa section Draft.
6. Giao diện kiểm tra trạng thái theo nhịp 2/5/10 giây và dừng khi có kết quả.

Comment trực tiếp của giảng viên là một lớp riêng: giảng viên bôi đoạn chữ trong dashboard, tạo thread và trả lời; học viên xem phần được đánh dấu và trả lời ngay trong handout. Thread không có thao tác xóa/ẩn và không làm thay đổi số lần Check, `failStreak`, trạng thái section hay hàng đợi n8n.

## Lesson 13 và dashboard giảng viên

- Trang học viên: `web/lesson.html?task=writing-lesson13-young-leaders`.
- Bản demo bài đã hoàn thành: `web/lesson-completed-demo.html`; chỉ dùng dữ liệu giả, không gọi API, database hoặc AI.
- Trang giảng viên: `web/teacher.html?task=writing-lesson13-young-leaders`; bắt buộc đăng nhập Google và được cấp quyền trong `mapping.reviewer_account`.
- Trang mô phỏng tải lớp: `web/teacher-live-demo.html`; dùng 40 học viên giả, không gọi API hoặc AI thật.
- Khi có thay đổi, trình duyệt vẫn lưu dự phòng cục bộ sau 500 ms và đồng bộ bản nháp lên database sau khoảng 15 giây. Chuyển ô, Check, Lưu và đóng đều yêu cầu lưu ngay.
- Dashboard lấy một bản tổng hợp của lớp mỗi 5 giây, hiển thị bản nháp và trạng thái chỉ đọc. Luồng này dùng API/PostgreSQL, không tạo execution n8n.
- Nếu AI lỗi, hệ thống tự thử tối đa ba lần trên cùng Comment. Sau ba lỗi, dashboard báo rõ và cho giảng viên xếp lại đúng lượt cũ; việc lưu bài vẫn tiếp tục độc lập.
- Activity Lesson 13 đã phát hành riêng cho IC2200; roster công khai hiện có 15 học viên, gồm mapping đã duyệt và ngoại lệ ERP được lưu nội bộ.
- Google Client ID trong cấu hình là định danh OAuth công khai; secret và token không được lưu trong repo.
- Kết quả kiểm thử và thông tin khôi phục nằm trong [biên bản phát hành Lesson 13](docs/PRODUCTION_DEPLOYMENT_2026-08-14_LESSON13_IC2200.md).

## Trạng thái phát hành

Push lên `main` chỉ chạy kiểm thử; bước xuất bản Pages phải được chạy thủ công sau release gate. Credential production, prompt chấm và dữ liệu học viên không nằm trong kho mã.
