# Reading Materials: kiểm và bổ sung kết quả AI

Phạm vi: Materials Buổi 10; bật bằng `gradingValidation.enabled=true` trong cấu hình riêng. Mặc định adapter cũ giữ tương thích khi không bật. Snapshot/đáp án/luật chấm vẫn ghim theo hash ban đầu; bản kiểm bổ sung có version riêng.

Mỗi vòng kiểm cấu trúc, ID, đủ các ý, kiểu và dẫn chứng, quan hệ, độ cô đọng, mã lỗi và lời giải thích. Ý/nhận xét chưa đạt được gửi bổ sung đúng phạm vi; ô đã được kiểm nội dung giữ theo hash. Bản chấm chỉ hoàn tất khi mọi phần bắt buộc đã qua code và kiểm nội dung AI. Không dùng nhận xét dự phòng để vượt lỗi.

Worker thực hiện một lời gọi AI mỗi lượt nhận job, lưu intent/response/checkpoint theo job và call ID. Vòng chưa đạt quay hàng chờ với thời gian tăng dần, không có ngưỡng bỏ bài sau ba lần. Mỗi lần gọi nằm trong lease 15 phút; request timeout 650 giây. Hàng chờ ưu tiên thời điểm sẵn sàng để bài bổ sung không chiếm liên tục bài mới. Các vòng và lượng token được lưu ở bảng riêng.

HTTP 429/5xx đã có phản hồi được xếp thử lại, giữ nguyên danh sách lỗi và phạm vi khóa. Mạng/timeout không rõ kết quả hoặc crash sau intent trước response giữ needs_review; phải đối soát trước gọi mới. Crash sau khi lưu response phát lại chính response đó, không gọi AI lần nữa. Khi hoàn tất checkpoint trước ghi result, tiếp tục lưu result từ dữ liệu đã qua kiểm.

Áp dụng migration bổ sung `docs/migrations/2026-10-26-reading67-validation.sql` bằng tài khoản phù hợp chỉ trên database Materials. Migration chỉ tạo ba bảng mới. Giữ nguyên web_attempt, nháp, archive, kết quả và cấu hình các sản phẩm khác.

`backend/scripts/recover-reading67-validation.mjs` nhận đường dẫn config và ID bản nộp. Mặc định chỉ xem trước; `--apply` giữ toàn bộ job lỗi gốc trong sự kiện recovery_started, kiểm fingerprint bài/hash bộ chấm/bài/version/lớp, rồi đưa đúng job failed về hàng chờ. Không tạo attempt, không đổi hash/nháp/bản nộp hoặc gọi AI ngay từ script. Chạy lại trả already_requested. Giao diện bản chấm ghi rõ đã phục hồi.

Quay lui: tắt cờ, quay đúng image và cấu hình trước phát hành; không restore database hoặc xóa ba bảng lịch sử mới. Đợi/đối soát lời gọi đang chạy trước chuyển container. Lượt đã có result không được chạy lại để quay code.

Kiểm: test validator, SQL/lease/crash/identity và các suite Reading/Web/Homework/SSO; ca lỗi gốc dùng snapshot/response riêng ngoài Git để chứng minh RED/GREEN. Browser Materials có trạng thái bổ sung/kiểm nội dung/chờ dịch vụ. Smoke AI thật dùng nội dung giả; fixture/mock không chứng minh kết quả của học viên thật.
