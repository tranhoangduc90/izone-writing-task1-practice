# Trang theo dõi chấm Writing 56/67

**Trạng thái 18/09/2026:** bản xây trên nhánh riêng, chưa phát hành. Migration `writing_flow` chưa áp dụng; API và dashboard chưa triển khai. Các workflow n8n mới đã tạo trong một thư mục riêng nhưng vẫn tắt, chưa có execution xuyên suốt.

## Tiếp nhận từng bài

Workflow đọc một tài liệu homework kiểm MIME thật từ Drive, giờ sửa file, mã lớp ở field Lark `Lớp` và loại đề theo bốn field `Ảnh biểu đồ`. Sau khi ghi **danh sách ô dự kiến** vào sổ quét, nó gọi workflow tiếp nhận riêng cho từng ô có bài hoặc ô lỗi mà không chờ ô khác. API nội bộ `/api/v1/internal/writing-flow/intake` nhận **đúng một cặp đề–bài** mỗi lần, đối chiếu định danh nguồn, loại đề, ảnh, mã hóa nội dung và ghi biên nhận cùng bàn giao bước sau. Quét lại cùng nội dung trả cặp cũ; sửa ô 4 chỉ tạo phiên bản mới cho ô 4. Một ô lỗi được lưu riêng, các ô hợp lệ vẫn chấm. Sổ quét chỉ tiến khi từng ô trong danh sách dự kiến đã có biên nhận đúng hoặc lỗi nguồn được lưu bền.

Khóa mã hóa 32 byte được cấp qua `WRITING_FLOW_ENCRYPTION_KEY` trên máy chủ, không lưu trong Git hoặc database. Nếu chưa có khóa, API từ chối tiếp nhận rõ ràng. API đang ở nhánh thử; chưa có workflow production nào gọi route này.

## Mỗi giai đoạn chấm

Workflow nhận `pairId`, phiên bản, mã bàn giao và gọi `/api/v1/internal/writing-flow/stages/claim`. API chỉ cấp một lượt thử cho cặp/bước đó và trả dữ liệu nguồn cùng thành quả các bước trước đã giải mã qua kênh nội bộ. Workflow hoàn tất gọi `stages/complete`, lỗi gọi `stages/fail`. Thành công được mã hóa và ghi bền rồi mới có bàn giao cho workflow sau; lỗi tạo yêu cầu thử lại ngay, tối đa ba lượt trong một chu kỳ. Sau lượt thứ ba, cặp vào **Cần kiểm tra**. Kết quả AI đến muộn vẫn được lưu nhưng không ghi đè lượt đã chốt hoặc phiên bản mới.

Thứ tự: kiểm trước khi chấm → chấm chính → phản biện → phân xử khi cần → xuất kết quả → ghi link vào homework. Bước ghi link chỉ được chốt khi workflow gửi bằng chứng đã đọc lại đúng file và URL HTTPS. Backend không tự đi đọc Google Docs; tính đúng của bằng chứng vẫn phải được kiểm trong workflow thử. Không có giới hạn ba bài đồng thời ở API này; n8n điều tiết concurrency.

API `handoffs/due` cấp các bàn giao chưa được bước sau xác nhận để n8n gọi lại cùng mã, không chờ workflow sau hoàn tất. API `handoffs/recover` tìm bước đã thực sự bắt đầu nhưng quá hạn: hai lượt đầu tạo bàn giao thử lại, lượt thứ ba đưa vào **Cần kiểm tra**. Cả hai route chỉ nhận token nội bộ. Workflow n8n gửi lại đã được tạo nhưng đang tắt, chưa nối API và chưa thử execution thật.

Khi chốt cả hồ sơ, API so file, vị trí link, ô và phiên bản hiện tại với lần hoàn tất trước. Nếu không đổi, n8n giữ “Thời điểm xong” cũ; nếu có phiên bản mới đã được giao đủ, n8n ghi thời điểm mới. Phần so phiên bản và quyết định mốc đã qua kiểm thử giả, chưa thử đường Lark/API thật. Nếu hồ sơ mới chưa giao đủ mà Lark còn mốc cũ, đường xóa mốc cũ vẫn chưa hoàn tất; chưa bật workflow chốt.

## Người vận hành thấy gì

Sau khi phát hành, mở `writing-flow.html` và đăng nhập bằng tài khoản Google có quyền quản trị. Trang sẽ hiện số bài ở từng trạng thái và nhóm các bài gần đây theo **lớp → hồ sơ homework → link file → bài số/Task**. Có nút mở file homework để đối chiếu; mã hồ sơ hiện ngay dưới tên nhóm. Nếu thiếu mã nguồn, bài vẫn hiện riêng để tránh gộp nhầm. Danh sách **Cần kiểm tra** giữ bước lỗi và nút chạy lại. Trang không hiện nội dung bài hoặc kết quả chấm chi tiết. Hiện tại đây mới là giao diện trên nhánh thử, chưa có URL production để mở.

Mỗi bài có mục **Xem nhật ký từng bước**. Mục này đọc từ database các mốc giai đoạn, từng lần thử, nhóm gọi AI, lệnh chuyển bước và lượt kiểm tra thủ công theo thời gian. Mã lượt chạy n8n gắn với dòng tương ứng để kỹ thuật viên mở execution. API cũng ghi một dòng JSON cho mỗi request Writing: mã truy vết, route, HTTP status, thời gian, mã bài/bước/lần thử và mã lỗi. Phản hồi có header `X-Writing-Request-Id` để đối chiếu; lỗi 500 trả chính mã đó trong body. JSON sai trả 400, body quá lớn trả 413 và vẫn dùng cùng mã truy vết. Lệnh bị chặn sớm vì nguồn truy cập hoặc giới hạn tốc độ vẫn có log. Đường dẫn chưa khớp route chỉ ghi phạm vi API cố định để tránh đưa chuỗi tự do vào log. Log không chứa bài viết, prompt, token, nội dung phản hồi AI hoặc ciphertext. Trang chỉ cho quản trị viên xem nhật ký; role thường nhận 403.

Nhật ký database tồn tại cùng hồ sơ bài; log API và execution n8n còn phụ thuộc chính sách lưu của máy chủ n8n/API. Trước khi mở thử cần xác nhận thời hạn lưu, dung lượng và quyền xem log; không coi một execution đã bị hệ thống dọn là bằng chứng có thể xem mãi. Các lỗi xảy ra trước khi tạo cặp bài có danh sách **Lỗi kỹ thuật gần đây** với nút mở đúng execution n8n. Error Trigger chỉ gửi mã workflow, tên workflow, mã execution, node cuối và loại lỗi; API không nhận stack hoặc bài viết. Migration cho bảng lỗi, route API, trang và node n8n đã được chuẩn bị, nhưng chưa thử đường ghi thật vì API/database chưa triển khai. Nếu API tạm hỏng, bản execution lỗi vẫn nằm trong n8n trong thời hạn lưu của máy chủ.

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
5. Sửa và thử bước chốt hồ sơ: API thử đã đối chiếu từng biên nhận với đúng hồ sơ, file, thứ tự link và ô bài, đồng thời trả dấu vân tay từng ô để workflow so với file mới đọc. Route chốt thử hiện từ chối yêu cầu thiếu bản đọc lại từng file, bản đọc quá năm phút hoặc dấu vân tay khác; 17 phép thử liên quan đạt. Workflow n8n chốt hồ sơ **chưa gửi bằng chứng mới**, nên nếu bật nguyên trạng sẽ không chốt được. Cần nối lượt đọc Docs/DOCX ngay trước khi chốt, thử sửa nội dung giữa chừng và giải quyết mốc cũ trong Lark khi có phiên bản mới. Chỉ sau đó mới mở luồng.
