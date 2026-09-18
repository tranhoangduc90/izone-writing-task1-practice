# Trang theo dõi chấm Writing 56/67

**Trạng thái 18/09/2026:** bản xây trên nhánh riêng, chưa phát hành. Migration `writing_flow` chưa áp dụng; API và dashboard chưa triển khai. Các workflow n8n mới đã tạo trong một thư mục riêng nhưng vẫn tắt, chưa có execution xuyên suốt.

## Tiếp nhận từng bài

Workflow đọc một tài liệu homework kiểm MIME thật từ Drive, giờ sửa file, mã lớp ở field Lark `Lớp` và loại đề theo bốn field `Ảnh biểu đồ`. Sau khi ghi **danh sách ô dự kiến** vào sổ quét, nó gọi workflow tiếp nhận riêng cho từng ô có bài hoặc ô lỗi mà không chờ ô khác. API nội bộ `/api/v1/internal/writing-flow/intake` nhận **đúng một cặp đề–bài** mỗi lần, đối chiếu định danh nguồn, loại đề, ảnh, mã hóa nội dung và ghi biên nhận cùng bàn giao bước sau. Quét lại cùng nội dung trả cặp cũ; sửa ô 4 chỉ tạo phiên bản mới cho ô 4. Một ô lỗi được lưu riêng, các ô hợp lệ vẫn chấm. Sổ quét chỉ tiến khi từng ô trong danh sách dự kiến đã có biên nhận đúng hoặc lỗi nguồn được lưu bền.

Khóa mã hóa 32 byte được cấp qua `WRITING_FLOW_ENCRYPTION_KEY` trên máy chủ, không lưu trong Git hoặc database. Nếu chưa có khóa, API từ chối tiếp nhận rõ ràng. API đang ở nhánh thử; chưa có workflow production nào gọi route này.

## Mỗi giai đoạn chấm

Workflow nhận `pairId`, phiên bản, mã bàn giao và gọi `/api/v1/internal/writing-flow/stages/claim`. API chỉ cấp một lượt thử cho cặp/bước đó và trả dữ liệu nguồn cùng thành quả các bước trước đã giải mã qua kênh nội bộ. Workflow hoàn tất gọi `stages/complete`, lỗi gọi `stages/fail`. Thành công được mã hóa và ghi bền rồi mới có bàn giao cho workflow sau; lỗi tạo yêu cầu thử lại ngay, tối đa ba lượt trong một chu kỳ. Sau lượt thứ ba, cặp vào **Cần kiểm tra**. Kết quả AI đến muộn vẫn được lưu nhưng không ghi đè lượt đã chốt hoặc phiên bản mới.

Thứ tự: kiểm trước khi chấm → chấm chính → phản biện → phân xử khi cần → xuất kết quả → ghi link vào homework. Bước ghi link chỉ được chốt khi workflow gửi bằng chứng đã đọc lại đúng file và URL HTTPS. Backend không tự đi đọc Google Docs; tính đúng của bằng chứng vẫn phải được kiểm trong workflow thử. Không có giới hạn ba bài đồng thời ở API này; n8n điều tiết concurrency.

API `handoffs/due` cấp các bàn giao chưa được bước sau xác nhận để n8n gọi lại cùng mã, không chờ workflow sau hoàn tất. API `handoffs/recover` tìm bước đã thực sự bắt đầu nhưng quá hạn: hai lượt đầu tạo bàn giao thử lại, lượt thứ ba đưa vào **Cần kiểm tra**. Cả hai route chỉ nhận token nội bộ. Workflow n8n gửi lại đã được tạo nhưng đang tắt, chưa nối API và chưa thử execution thật.

## Người vận hành thấy gì

Mở `writing-flow.html`, đăng nhập bằng tài khoản Google có quyền quản trị. Trang hiện số bài ở từng trạng thái theo lớp, các bài gần đây và danh sách **Cần kiểm tra**. Mỗi dòng ghi rõ hồ sơ nguồn, file homework, link thứ mấy và bài số mấy. Trang không hiện nội dung bài hoặc kết quả chấm chi tiết.

Sau ba lượt chấm hoặc ghi kết quả chưa xong, một bài xuất hiện trong **Cần kiểm tra** với bước lỗi và lý do gần nhất. Sau khi kiểm, quản trị viên chọn **Chạy lại từ bước này**. API ghi yêu cầu vào `writing_flow.manual_review` và `writing_flow.handoff` trong cùng transaction. Trang đọc lại trạng thái `Đã yêu cầu chạy lại`; trạng thái này chưa có nghĩa bài đã được chấm hoặc link đã được ghi. Workflow retry phải nhận yêu cầu, xác nhận và chỉ chạy lại đúng bước lỗi.

Các link không đọc được hoặc khác Google Docs/DOCX xuất hiện riêng ở **Tài liệu chưa nhận được**. Workflow tiếp nhận gửi mã lỗi bằng token nội bộ; API chỉ lưu mã hồ sơ, mã file, lớp, thứ tự link và lý do, không lưu URL gốc hay nội dung bài. Khi cùng file được tiếp nhận thành công, mục lỗi tương ứng tự chuyển sang đã xử lý.

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
