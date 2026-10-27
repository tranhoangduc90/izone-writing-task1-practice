# Reading Homework Lesson 12 — 27/10/2026

Bài TF/NG dùng engine Homework của Materials: 9 đoạn đọc, 6 câu; mỗi câu có 3 ô đối chiếu, 3 nhãn và 1 kết luận toàn câu. Tổng 42 mục, đủ cả 42 mới gửi chấm. AI kiểm nội dung và bổ sung phản hồi đến đạt hợp đồng; học viên sửa/nộp lại đến đúng toàn bộ. Không có timer/band.

Mã `67-reading-homework-butterflies-britain-tfng`, version `butterflies-tfng-l12-20261027-v1`. URL Pages `reading-skills67/butterflies-britain-tfng/`; API lồng `/reading67-materials/api/reading-skills67/lesson12`. Nội dung và rubric nằm trong cấu hình private, không đưa key vào Pages. Rubric SHA256 `315fa55c8759133bb3317c06ad9415c12af303f4b3fe8e601609d550600848f2`.

Runtime cùng DB Materials, giữ scope owner/class/code/version cho nháp, bản nộp, kết quả, job chấm và Docs. Bộ chấm mới dùng vòng kiểm/bổ sung chung đã tách khỏi grader cũ. Đọc snapshot lớp theo hợp đồng ERP hiện hành; quyền từng bài vẫn qua allowlist. Primary Materials giữ lớp 1293 và owner V1 cũ.

Lesson 12 đăng ký 14 lớp ERP khóa 67 đang học/sắp mở. Nguồn riêng `izone-reading12-owner-source` chỉ đọc view `reading_owner_api_v1.homework_lesson12_owner`; SQL giữ approved mapping, approved Classroom course, active membership và loại dropped/on_hold. Không đổi view owner cũ, không duyệt thêm định danh. Ngày phát hành có 122 người dùng hợp lệ thuộc 9 lớp; IC2314, IC2340, IC2353, IC2363, IC2376 chưa có approved UUID nên chờ nguồn.

`managedCodes` được ghim từ cấu hình bài khi mở runtime. Kiểm mã trên snapshot đăng ký và mọi snapshot worker dùng lập lệnh/đọc lại; Docs thêm mã bài thứ hai giữa các bước phải dừng trước ghi. Revision Google và khóa job vẫn giữ. Giảng viên chỉ xem, kể cả khi chuyển sang cách hiển thị học viên.

Kiểm: AI thật với mẫu đúng 42/42 và mẫu cố ý sai đúng 4 ô; source/progress/schema, lease/retry, cách ly hai bài, identity, SQL/API/Docs hồi quy; 5 viewport đi hết vòng sửa; SSO 24 ca; Docs thử thật CTA/status/retry và chữ/link tay. Chrome có phiên GV thật mở được lớp và bài ở chế độ chỉ xem. Không nộp/chấm bài học viên thật; chưa có bản giao Classroom Lesson 12 để chứng minh toàn tuyến sao chép thực tế.

Gói private và biên nhận: `E:/Codex-Data/reading12-tfng-20261027`. VPS1 release `/opt/izone-reading12-tfng-20261027`; container app `izone-reading67-materials-ic2304` dùng image Homework Lesson 12. Giữ user node, rootfs read-only, port/mount/network cũ, nguồn owner mới riêng. Đối chiếu hash bài/nháp/kết quả cũ trước/sau. Rollback chỉ code/config theo container đã dừng, không restore DB hoặc chấm lại; xem snapshot runtime và script đổi bản trong gói private.

Workflow CTA `f9JNQ9Vui36U8Tz5` tại profile default chỉ đổi hai Code node nhận mã/kiểm ACK; trigger và credential giữ nguyên. Native dev `ol1LSmbszlzD2xNj`, execution `3028054`, đạt 13 ca giả, đang inactive. Owner task này; giữ để đối soát trong 7 ngày, archive/delete cần quyền riêng, không tự đặt lịch dọn.
