# Native Homework: startup và hàng nguồn logger, chưa phát

Ngày06/11/2026. Bản này chỉ thêm logger vào hai Homework native. Không rebuild từ canonical main thiếu overlay, không đổi hành vi lưu/chấm/Docs, phạm vi lớp hay Google SSO. Cả năm sản phẩm P4 chưa mở production.

## Nguồn và cấu hình

`overlay-manifest.json` ghim hai image/source và ba đầu vào merge. Reading10file mới/sửa, giữ42file; Listening9file mới/sửa, giữ38file. Cả script serve, factories bài bổ sung/Headings và Docs runtime nhận cùng intake đúng product. Giữ ownerEntry.refresh, COURSE67_SCOPE_UNAVAILABLE, coordinator/SSE, bộ chấm, nhãn Reading và Listening riêng. Helpers canonical ở backend/src/reading-listening67 chỉ là nguồn dùng lại; bản phát phải dùng delta trên source native đã ghim.

Thư viện chung yêu cầu izone-AI-team commit b3a53cf6970676a77dd6a1389ee6ea19d79d9c93. Cờ EXAM_JOURNAL_ENABLED khác1 không đọc cấu hình/import SDK. Bật1 dùng EXAM_JOURNAL_LIBRARY_ROOT (mặc định /opt/exam-journal) và EXAM_JOURNAL_CONFIG_FILE riêng. Mount phải đọc được bằng UID runtime. Cấu hình lỗi giữ nghiệp vụ chạy và phát mã logger cố định.

## Ngừng dịch vụ và tính bền vững

Dừng nhận HTTP/stream, dừng workers/Docs, chờ nguồn/transport rồi đóng DB. Callback lưu/nộp, tra scope worker và tiến độ Docs cùng đăng ký trước setImmediate. Hàng nguồn tối đa1024, chờ shutdown mặc định20giây. Hàng đầy không được chạy callback/SQL ngoài hàng. Scope chỉ đọc theo job/attempt/owner/lease bất biến và được cache một lần. Lỗi/timeout/overflow/retry chưa hết báo shutdown_unknown, không gọi RAM là durable ACK. Không chuyển prompt, đáp án, Share text, token hoặc URL đầy đủ vào log.

## Kiểm

17ca thư viện liên quan đạt Windows/Linux;4ca helper nguồn và6ca startup đạt mỗi hệ. Startup thực thi scripts native, factories ba bài mỗi sản phẩm, Docs runtime và bridge/SDK; SQL/Google/HTTP/grader/RPC là double cô lập. Không thay kiểm đầu cuối bằng mock.

Native SQL PGlite/worker/Docs Reading23ca, Listening27ca có bằng chứng riêng. Ca mới ban đầu thiếu afterCommit trong fixture; sửa theo Postgres và chạy lại đúng phần thiếu. Ca Reading phải từ chối nhãn Listening theo formatter native riêng, không sửa runtime để nới contract. Giữ lỗi thử startup thiếu export mock và lỗi junction/symlink trước khi chạy. Không gọi Google/AI/Drive thật trong lát này.

19patch đã áp lại lên source raw sạch, đủ hash candidate và80file ngoài phạm vi khớp. Ngữ cảnh nguồn có CRLF nên patch giữ raw bytes qua Git -text; không chuẩn hóa line ending của patch. Lượt đầu giả định tất cả patch phải LF dừng trước apply, giữ riêng trong hồ sơ. Không dùng hash chuẩn hóa để nhận một source raw khác là đúng baseline.

Runner check-native-startup.mjs nhận ba đường dẫn: Reading native root, Listening native root, shared exam-journal library root. Chạy Node với --experimental-vm-modules. Runner thực thi đúng script/factory/Docs runtime, cấm mạng ngoài fixture, trả JSON mode/hash/thứ tự đóng hoặc exit khác0 khi assertion lỗi. Chỉ dùng kiểm composition, không thay native SQL hoặc nghiệm thu server thật.

## Phát và quay lui còn lại

Trước phát chụp source/route/container/hoạt động mới, so hash nền và ghép lại nếu có drift. Còn Agent8 trong128MiB, ngân sách backup, registry/config/mount/flag/canary/rollback. Không phát trong lượt thi. Rollback dùng cờ tắt/image tương thích, giữ registry/khóa/dữ liệu đã công bố; không restore DB cũ. Collector giữ0,50CPU/512MiB, Agent0,05CPU/128MiB và quota4GB.

Bằng chứng private: E:/Codex-Projects/New project/private-deployments/log-first-release-20261103/homework-p4-homework-startup-r1/README.md. Cửa vào chung: tools/exam-journal/optimization/LEARNING_PRODUCER_STARTUP_20261106.md trong izone-AI-team.
