# Vận hành backend CTA K67

Service chạy Node 24 với một pool PostgreSQL nghiệp vụ tối đa bốn kết nối, một pool Mapping chỉ đọc tối đa hai kết nối, một nhịp quét và một worker xử lý. Kết nối vào mạng nội bộ ứng dụng. Để cổng 8789 trong mạng đó. Dùng file cấu hình ngoài image qua `K67_CTA_RUNTIME_CONFIG`, gắn các file khóa riêng dưới `/run/k67-cta` để chỉ UID chạy service đọc được. File mẫu ghi đường dẫn và tên máy đích.

Backend quét dưới khóa advisory của phiên PostgreSQL riêng với lease quét n8n. Lịch và lệnh chạy tay của backend tranh cùng một khóa. PostgreSQL nhả khóa khi kết nối mất. Trong giai đoạn hai bên cùng hoạt động, chỉ scope đã trao quyền theo epoch mới được backend phát việc. Dùng `cta_native_slot` và log `scan`/`scan_busy`, nối `parentRunId` với `runId` để tìm đúng lớp, lần phát và biên nhận worker.

Sau mỗi lớp, scheduler đánh thức worker cùng tiến trình ngay khi đã lưu việc và kết thúc lượt đối soát Speaking của lớp đó. Trang vận hành đánh thức worker sau lượt gửi tay. Worker vẫn kiểm PostgreSQL khi khởi động và có nhịp dự phòng 10 giây để khôi phục việc đã lưu khi mất tín hiệu hoặc khởi động lại. Nếu một nhánh khác đang giữ khóa của đúng Docs, worker trả việc về hàng và nghỉ một giây. Log `worker_deferred` nối với lần nhận qua `runId` và `executionId`.

Áp dụng migration `2026-11-19-k67-cta-native-runtime.sql` trên đúng database CTA Reading/Listening đã có schema. Migration thêm ba bảng và không phân quyền backend sở hữu lớp nào. Runtime đọc quyền sở hữu, vận hành hàng và slot. Nhà vận hành giữ riêng quyền chuyển chủ từng lớp. Với `enabled=false`, `GET /ready` kiểm OAuth đúng tài khoản và quyền đến các bảng. Lượt chỉ đọc dữ liệu Classroom dùng script shadow riêng với role và Google OAuth chỉ đọc.

Writing dùng đường nguồn riêng theo migration `2026-11-19-k67-cta-writing-source.sql`. Để `writing.enabled=false` đến lúc đã xác minh registry live, nguồn đúng lớp/bài và intake thật. Khi mở, kết nối registry chỉ có quyền đọc và URL đích lấy từ dịch vụ Writing đang chạy. Đối chiếu receipt riêng. Giữ lượt đối soát native Writing đến khi ca Docs đến muộn được xác minh qua nguồn chung.

## Lịch và đường chạy tay

- `GET /ready` dùng Bearer nội bộ. Trả 200 khi các phụ thuộc khởi động và bảng cần thiết đọc được.
- `POST /manual` dùng Bearer nội bộ. JSON gồm `classCode` và tùy chọn `courseWorkId`. Chỉ lớp do backend sở hữu mới có thể phát việc. Lượt trả kết quả quét và số việc đã đưa vào hàng, kết quả ghi đến sau qua worker.
- `POST /manual-docs/submit` và `POST /manual-docs/status` dùng cùng Bearer nội bộ. JSON nhận tối đa 20 `docId` duy nhất. Kết quả theo từng Doc, gồm tìm nguồn, nguồn mơ hồ, chưa xử lý, đã lên hàng và đã xác minh. Tích hợp nhánh web qua gateway có phiên vận hành. Giữ token trong gateway, ngoài mã Pages. Trang tương thích cũ còn gọi cả hai webhook n8n, cần chuyển cả gửi và kiểm trạng thái.
- `POST /operator/cta/submit` và `POST /operator/cta/status` dùng cùng hợp đồng Docs qua phiên giảng viên IZONE. Khi chuyển trang, cấp khóa consumer SSO `k67-cta` và đặt file JSON danh sách Google subject được vận hành. Chỉ công bố hai path này sau gateway HTTPS. Trang gọi từ origin được duyệt với `credentials: include` và `X-Izone-Csrf: 1`. Giữ `manualPage.enabled=false` cho đến khi xác minh phiên thật và quyền cả hai nút. Log chỉ ghi hành động, số Docs và mã kết quả xác thực.

## Chuyển và quay lui

Chốt snapshot nguyên trạng từng workflow, revision live, queue và lease theo đúng scope. Chạy QA trên VPS2 với các registrar đúng sản phẩm, kiểm cả ACK, Google readback, lỗi một phần và quyền vào bài. Khi chuyển một lớp, khóa tuyến n8n theo lớp, chờ in-flight cũ kết thúc, đọc lại queue và receipt. Sau đó mới ghi `owner=backend` cho chính khóa Classroom/lớp với epoch mới. Với lớp có bản sao đủ điều kiện, đối chiếu một lượt định kỳ và một lần chạy tay, link và quyền đúng chủ, replay giữ nguyên revision. Mở dần từ IC2353.

Quay lui bằng trạng thái `draining` và epoch tăng. Kiểm writer, job lease và nguồn đang có kết quả chưa xác định, chạy đọc lại đúng Docs trước khi giải quyết. Khôi phục tuyến n8n đã ghim cho phạm vi cần trả lại, đổi quyền về n8n và kiểm một nhịp thật. Giữ biên nhận, Docs đã gắn, lịch sử làm bài và queue. Thao tác thực tế của từng đợt lấy revision/epoch từ preflight ngay lúc thực hiện.
