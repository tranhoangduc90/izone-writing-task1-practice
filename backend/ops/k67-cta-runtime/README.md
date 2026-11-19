# Vận hành backend CTA K67

Service chạy Node 24 với một pool PostgreSQL nghiệp vụ tối đa bốn kết nối, một pool Mapping chỉ đọc tối đa hai kết nối, một nhịp quét và một worker xử lý. Kết nối vào mạng nội bộ ứng dụng. Để cổng 8789 trong mạng đó. Dùng file cấu hình ngoài image qua `K67_CTA_RUNTIME_CONFIG`, gắn các file khóa riêng dưới `/run/k67-cta` để chỉ UID chạy service đọc được. File mẫu ghi đường dẫn và tên máy đích.

Áp dụng migration `2026-11-19-k67-cta-native-runtime.sql` trên đúng database CTA Reading/Listening đã có schema. Migration thêm ba bảng và không phân quyền backend sở hữu lớp nào. Runtime đọc quyền sở hữu, vận hành hàng và slot. Nhà vận hành giữ riêng quyền chuyển chủ từng lớp. Với `enabled=false`, `GET /ready` kiểm OAuth đúng tài khoản và quyền đến các bảng. Lượt chỉ đọc dữ liệu Classroom dùng script shadow riêng với role và Google OAuth chỉ đọc.

Writing dùng đường nguồn riêng theo migration `2026-11-19-k67-cta-writing-source.sql`. Để `writing.enabled=false` đến lúc đã xác minh registry live, nguồn đúng lớp/bài và intake thật. Khi mở, kết nối registry chỉ có quyền đọc và URL đích lấy từ dịch vụ Writing đang chạy. Đối chiếu receipt riêng. Giữ lượt đối soát native Writing đến khi ca Docs đến muộn được xác minh qua nguồn chung.

## Lịch và đường chạy tay

- `GET /ready` dùng Bearer nội bộ. Trả 200 khi các phụ thuộc khởi động và bảng cần thiết đọc được.
- `POST /manual` dùng Bearer nội bộ. JSON gồm `classCode` và tùy chọn `courseWorkId`. Chỉ lớp do backend sở hữu mới có thể phát việc. Lượt trả kết quả quét và số việc đã đưa vào hàng, kết quả ghi đến sau qua worker.
- `POST /manual-docs/submit` và `POST /manual-docs/status` dùng cùng Bearer nội bộ. JSON nhận tối đa 20 `docId` duy nhất. Kết quả theo từng Doc, gồm tìm nguồn, nguồn mơ hồ, chưa xử lý, đã lên hàng và đã xác minh. Tích hợp nhánh web qua gateway có phiên vận hành. Giữ token trong gateway, ngoài mã Pages. Trang tương thích cũ còn gọi cả hai webhook n8n, cần chuyển cả gửi và kiểm trạng thái.

## Chuyển và quay lui

Chốt snapshot nguyên trạng từng workflow, revision live, queue và lease theo đúng scope. Chạy QA trên VPS2 với các registrar đúng sản phẩm, kiểm cả ACK, Google readback, lỗi một phần và quyền vào bài. Khi chuyển một lớp, khóa tuyến n8n theo lớp, chờ in-flight cũ kết thúc, đọc lại queue và receipt. Sau đó mới ghi `owner=backend` cho chính khóa Classroom/lớp với epoch mới. Với lớp có bản sao đủ điều kiện, đối chiếu một lượt định kỳ và một lần chạy tay, link và quyền đúng chủ, replay giữ nguyên revision. Mở dần từ IC2353.

Quay lui bằng trạng thái `draining` và epoch tăng. Kiểm writer, job lease và nguồn đang có kết quả chưa xác định, chạy đọc lại đúng Docs trước khi giải quyết. Khôi phục tuyến n8n đã ghim cho phạm vi cần trả lại, đổi quyền về n8n và kiểm một nhịp thật. Giữ biên nhận, Docs đã gắn, lịch sử làm bài và queue. Thao tác thực tế của từng đợt lấy revision/epoch từ preflight ngay lúc thực hiện.
