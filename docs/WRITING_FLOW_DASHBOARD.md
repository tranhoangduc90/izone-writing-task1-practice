# Trang theo dõi chấm Writing 56/67

**Trạng thái 17/09/2026:** bản xây trên nhánh riêng, chưa phát hành. Cần migration `writing_flow`, API nhận/giao giai đoạn và workflow retry hoạt động trước khi bật trang cho người vận hành.

## Tiếp nhận từng bài

API nội bộ `/api/v1/internal/writing-flow/intake` nhận một tài liệu đã tách tối đa bốn ô bài trong một request. Nó kiểm loại file bằng MIME thật, giờ sửa từ Drive, mã lớp, đúng số ô có bài và loại đề của từng ô. API tự tính dấu nội dung, mã hóa đề/bài, ghi từng cặp và yêu cầu bàn giao trong cùng transaction. Quét lại cùng nội dung trả cặp cũ; sửa ô 4 chỉ tạo lượt mới cho ô 4; bản đọc file cũ không được đẩy vào chấm. Nếu một cặp ghi thất bại, cả tài liệu rollback và mốc quét ToolTG phải giữ nguyên.

Khóa mã hóa 32 byte được cấp qua `WRITING_FLOW_ENCRYPTION_KEY` trên máy chủ, không lưu trong Git hoặc database. Nếu chưa có khóa, API từ chối tiếp nhận rõ ràng. API đang ở nhánh thử; chưa có workflow production nào gọi route này.

## Người vận hành thấy gì

Mở `writing-flow.html`, đăng nhập bằng tài khoản Google có quyền quản trị. Trang hiện số bài ở từng trạng thái theo lớp, các bài gần đây và danh sách **Cần kiểm tra**. Mỗi dòng ghi rõ hồ sơ nguồn, file homework, link thứ mấy và bài số mấy. Trang không hiện nội dung bài hoặc kết quả chấm chi tiết.

Sau ba lượt chấm hoặc ghi kết quả chưa xong, một bài xuất hiện trong **Cần kiểm tra** với bước lỗi và lý do gần nhất. Sau khi kiểm, quản trị viên chọn **Chạy lại từ bước này**. API ghi yêu cầu vào `writing_flow.manual_review` và `writing_flow.handoff` trong cùng transaction. Trang đọc lại trạng thái `Đã yêu cầu chạy lại`; trạng thái này chưa có nghĩa bài đã được chấm hoặc link đã được ghi. Workflow retry phải nhận yêu cầu, xác nhận và chỉ chạy lại đúng bước lỗi.

## Quyền và dữ liệu

- Chỉ tài khoản `mapping.reviewer_account` với `role=admin` đọc trang hoặc yêu cầu retry. Các tài khoản giảng viên khác nhận 403.
- API không trả `source_ciphertext` hoặc `result_ciphertext`. Mã hồ sơ và mã tài liệu chỉ hiện sau khi quyền quản trị đã được xác minh.
- Danh sách cặp tải từng trang 100 bài; nút **Xem thêm bài** đọc trang tiếp. Số tổng hợp lấy toàn bộ database. Danh sách lỗi đọc đủ các trang 200 mục.
- Bấm lại cùng `requestId` trả biên nhận cũ; yêu cầu khác trên cùng một mục đã gửi trả 409. Workflow nhận phải dùng `retry_command_key` để chống chạy trùng.

## Điều kiện trước phát hành

1. Migration `writing_flow` đã được thử trên database tạm, sao lưu và áp dụng có đọc lại.
2. Tài khoản API chỉ được cấp quyền cần thiết trên schema mới; workflow nhận yêu cầu retry đã được thử cả nhánh lỗi.
3. Kiểm bằng tài khoản quản trị và giảng viên thường, kiểm dữ liệu thật ở phạm vi tối thiểu; đối chiếu một dòng trạng thái với database.
4. Đối chiếu source backend đang chạy trước khi phát hành: nhãn image và source runtime từng khác nhau ngày 14/09/2026. Không lấy nhánh này làm bằng chứng production đã đổi.
