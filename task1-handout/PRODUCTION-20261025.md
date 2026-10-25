# Chuyển Task 1 chuyên sâu sang backend riêng — 25/10/2026

## Kết quả và phạm vi

Đức đã cho phép chuyển sáu bài Task 1 đang dùng sang backend riêng trên VPS1, giữ nguyên link, bài làm và toàn bộ lịch sử. Cutover hoàn tất lúc `2026-10-25T03:28:03Z` (10:28 giờ Việt Nam); bước khóa ghi, xuất cuối, nhập, đối chiếu và đổi tuyến mất 8,73 giây. Task 2, Writing 56–67 và các sản phẩm khác giữ backend hiện hành.

Sáu slug: `pie-app-users-by-age`, `australian-destinations-1999-2009`, `australian-physical-activity-2010`, `new-zealand-employment-1993-2003`, `average-earnings-by-sector-2000-2010`, `mobile-phone-market-share-1994-2004`.

Link `writing-handouts/index.html`, `teacher.html`, thư viện, manifest và hình đề cũ được giữ. Nội dung sáu manifest thật không đổi. Frontend vẫn gọi `/writing-api/`, nên giữ khóa lưu nháp của trình duyệt và tương thích tab đã mở. Bộ định tuyến riêng chọn Task 1 bằng slug hoặc đúng loại thực thể và UUID; các yêu cầu còn lại chuyển tiếp đến API Writing cũ. Không chuyển đồng loạt API của sản phẩm khác.

## Dữ liệu và chống ghi hai nơi

Snapshot cuối được đối chiếu toàn bộ trường của 18 bảng trước khi mở tuyến. Giữ nguyên khóa chính, UUID, thời gian, bài viết, PIN hash/salt, trạng thái, lịch sử AI và trao đổi giảng viên. Số lượng tại cutover:

| Bảng | Bản ghi |
| --- | ---: |
| activity | 6 |
| activity_class_scope | 13 |
| activity_roster | 279 |
| activity_roster_override | 55 |
| activity_section_definition | 0 |
| provisional_student | 20 |
| activity_student_alias | 0 |
| provisional_student_audit | 20 |
| activity_session | 92 |
| session_section | 276 |
| draft_request | 669 |
| check_attempt | 574 |
| comment | 574 |
| admin_audit_event | 0 |
| teacher_comment_thread | 9 |
| teacher_comment_message | 13 |
| teacher_comment_status_event | 0 |
| grading_dispatch | 448 |

Chỉ ba trường cấu hình prompt của sáu activity trong DB đích được đổi: phiên bản `2026-10-25.socratic-v2.5`, registry riêng và tham chiếu Socratic. Context/metadata của lượt chấm cũ không bị thay thế hay chấm lại. Snapshot gốc nguyên văn lưu trong `task1_private.migration_archive`; role runtime không có quyền sửa/xóa kho này. SHA-256 snapshot chuẩn hóa: `6ef8fe3f3dc76216322a4612d1f026c98bf1858a6bd80c2810f75d373800b4f4`.

Nguồn cũ giữ đủ dữ liệu và đã khóa ghi riêng sáu activity bằng trigger `sw_task1_moved_guard`, lỗi `TASK1_MOVED_TO_DEDICATED_BACKEND`. DELETE riêng dữ liệu đã chuyển được bỏ qua để job dọn chung không xóa lịch sử hoặc hỏng sản phẩm khác. DB đích có `cutover_state=live`; importer từ chối nạp lại vào trạng thái này.

Sau cutover, học viên có thể tiếp tục viết và Check. Đối chiếu sau phát hành xác nhận nguồn cũ không đổi, mọi ID và mọi trường cũ của cả 18 bảng đều còn nguyên, snapshot lưu trữ khớp gốc. Riêng sáu bài thật đã tăng lên 107 phiên, 726 yêu cầu lưu và 623 lượt Check/feedback: 49 lượt Check mới đã hoàn tất. Bốn lượt QA nằm ở activity riêng. Không yêu cầu tổng số bản ghi đích bằng snapshot khi đã có bài mới; nháp và trạng thái hiện hành được phép tiến triển từ thao tác mới của người dùng.

## Runtime hiện hành

- Thư mục `/opt/izone-sw-task1`; DB PostgreSQL riêng `sw-task1-db`, database `sw_task1`, owner `task1_owner`, runtime `task1_api`.
- API `sw-task1-api`: image `sw-task1:20261025.4`, localhost `18930` → `8790`; image ID `sha256:03dbc27cbddd4b713f87c480b8b3dedb38106a5d3fad2db4d774eb09ea543dfb`.
- Worker `sw-task1-worker`: image `sw-task1:20261025.3`; image ID `sha256:d0b980ee8df60d5f3eb35d0a9e438f2ef4f127684fd1f53486bef6cef1d5ae8f`. Bản .4 chỉ sửa CSV/admin scope phía API; không đổi code chấm hoặc restart worker đang nhận việc.
- Network riêng `sw-task1-production`. API/worker có hạn mức CPU/RAM/PID, root filesystem chỉ đọc, bỏ capability, no-new-privileges và xoay log. Worker tối đa hai lượt AI toàn cục.
- `/writing-api/` → API riêng `/_legacy/`; `/task1-api/` → API riêng. `/task1-api/api/v1/internal/` và các lối router lồng bị chặn công khai. Health/ready nhận diện `sw-task1`.

Không dừng API Writing cũ: đăng nhập dùng chung, thư viện, đọc kết quả LMS cũ và các sản phẩm Writing khác vẫn cần nó. Không sửa broker, workflow hoặc DB của Task 2/56–67 để bảo trì Task 1.

## Google, quyền và mã học viên

Dùng broker Google hiện hành và consumer Task 1 đã đăng ký. Quyền giảng viên được kiểm trực tiếp qua role chỉ đọc `sw_task1_reader` trên schema cầu nối `task1_bridge`: ba hàm SELECT được cấp tường minh, không có quyền đọc bảng nguồn hoặc ghi mapping. Khi nguồn quyền lỗi/thu hồi thì từ chối, không dùng quyền cũ dự phòng. Quyền quản lý và quyền xem tất cả lớp được phân biệt.

Pepper mã học viên được giữ byte nguyên gốc; 20 hash/salt cũ được đối chiếu. Không đặt lại mã hoặc tạo lại danh tính học viên. Google cookie/token không được trích xuất để giả lập xác thực.

## Bằng chứng kiểm tra

- Backend: 22/22 test, gồm giữ lịch sử/context, draft conflict, PIN và mở lại bài, comment hai chiều, scope/thu hồi quyền, queue/lease/retry, chống gắn nhầm kết quả, router tương thích và CSV chín cột. Chạy tuần tự với `node --expose-gc --test --test-concurrency=1`; lần chạy PGlite song song trước đó thiếu bộ nhớ máy test, đã khắc phục giải phóng WASM giữa fixture và chạy tuần tự.
- Frontend: 200/200 test; kiểm cú pháp và diff; sáu manifest thật không đổi. Pages PR [280](https://github.com/tranhoangduc90/izone-ai-team-pages/pull/280) nối luồng Socratic, PR [284](https://github.com/tranhoangduc90/izone-ai-team-pages/pull/284) đổi nhãn dòng thời gian Draft. Cả hai đã merge và Pages báo `built`.
- Kiểm Google thật: vào thư viện và dashboard qua liên kết gốc; đăng nhập Google trong trình duyệt, tải lại và tab mới vẫn giữ phiên; xem bài/lượt chấm cũ của lớp thật. Không nộp, chấm, sửa hoặc gửi comment vào bài thật để thử.
- Lớp QA riêng: học viên nhập PIN, tải lại lịch sử, lưu Draft, Check qua worker/AI thật, mở lại đúng nội dung; giảng viên nhận xét trên từ được đánh dấu, học viên trả lời, giảng viên đánh dấu đã xử lý; tải lại vẫn đủ hai tin nhắn và trạng thái. CSV tải qua giao diện có đúng chín cột báo cáo cũ.
- QA có bốn Check hoàn tất, một thread, hai tin nhắn, một thread đã xử lý. Scope QA đã đóng sau kiểm; giữ toàn bộ dữ liệu thử để truy vết. Phạm vi 13 lớp thật không đổi.

Biên nhận và ảnh riêng tại `E:/Codex-Data/private-evals/task1-cutover-20261025`; raw snapshot và credential không đưa vào Git/Pages. Biên nhận VPS: `cutover.json`, `current-release.json`, `readback.json`, `qa-final.json`. Chưa kiểm trên điện thoại vật lý, đăng xuất live hoặc tải mô phỏng cả lớp trong lượt chuyển này.

## Khôi phục và thay đổi tiếp

Chỉ quay image/code khi cần, giữ DB hiện hành và bài mới. Không chạy lại provision/import/rehearsal/cutover, không restore snapshot cũ đè lên DB đã nhận bài. Không mở lại ghi nguồn hoặc đổi route về nguồn cũ khi chưa có phương án đồng bộ ngược và đối chiếu phần phát sinh mới. Các container API cũ đang dừng chỉ là phương tiện khôi phục code, không phải DB thay thế.

Source backend được lưu trên branch local `codex/task1-socratic-backend-20261025-writing-practice`; chưa push/merge backend. Frontend đã phát hành qua hai PR nêu trên. Thêm lớp/bài mới cần đăng ký phạm vi và nguồn quyền tương ứng; không suy ra từ quyền cutover sáu bài này.
