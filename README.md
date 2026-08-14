# IZONE Writing Task 1 Practice

Web app luyện **Overview**, **Outline hai thân bài** và **Draft 1 → Draft 2** không phụ thuộc Google Docs.

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
5. Workflow n8n lấy công việc, dùng Prompt Registry + Gemini Hub và ghi lại kết quả.
6. Giao diện kiểm tra trạng thái theo nhịp 2/5/10 giây và dừng khi có kết quả.

## Trạng thái phát hành

Đây là bản triển khai DEV. Push lên `main` chỉ chạy kiểm thử; bước xuất bản Pages phải được chạy thủ công sau release gate. Không có workflow n8n nào được tự động bật, không thay link Google Docs hiện tại và không có credential production trong kho mã.
