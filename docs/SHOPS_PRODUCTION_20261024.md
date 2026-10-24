# Shops — phát hành 24/10/2026

- Học viên: https://tranhoangduc90.github.io/izone-ai-team-pages/shops-writing/
- Giảng viên: https://tranhoangduc90.github.io/izone-ai-team-pages/shops-writing/teacher.html
- Pages PR: https://github.com/tranhoangduc90/izone-ai-team-pages/pull/261 — merge `a240abf08e8f80967395d53f8705f589294ba490`, Pages build `40087911900` thành công.

Đức đã duyệt phát hành và xác nhận phạm vi “mọi lớp CS”. Đã mở CS.160826 (23 học viên), CS.181026 (24); giữ quyền và lịch sử CS.070626 (23). Lớp kiểm triển khai đã đóng. Luồng giữ Lesson 9 và Draft 1 → Draft 2. Chấm từng câu kế thừa hợp đồng Writing 56–67 qua bản sao riêng, không gọi các workflow Writing 56–67 và không dùng Lark/Docs.

## Runtime sở hữu riêng

Root VPS `/opt/izone-shops-writing`, release `releases/20261024.1`. API prefix `/shops-writing-api/`, localhost 18927; containers `shops-writing-api`, `shops-writing-db`, `shops-writing-writer`; database `shops_writing`; role API `shops_api`; kho kết quả `results/`. API image sau bản vá hàng chờ `sha256:22001a6e085d0cc83a75527fd48ed65ce1797279e8a28930c310510c0383d8fb`.

Worker `shops-writing-worker.service` đã enable, hai lượt đồng thời, khôi phục lease mỗi 30 giây. Workflow chính `pp7D1b3dMwAYZEZf` active; Draft child `bEcyXv7COYsWOVH4`, Error Trigger `QIoakLvC0SF1KWOr`. Redis key riêng `ielts:writing:shops:prompt_registry:20261024.1`. Google dùng nguồn `shops` trên broker phiên chung; các nguồn cũ, image broker và database phiên chung được giữ nguyên.

Đã sao chép đúng 16 phiên, 99 attempt, 99 nhận xét và lịch sử trao đổi cũ. Trigger chấm ở schema mới tự thêm grading_context cho các attempt cũ có NULL khi import; metadata gốc đã được khôi phục trước khi mở. Source Shops cũ đóng và chỉ chặn INSERT/UPDATE dữ liệu Shops bằng trigger có điều kiện activity 8; không đóng các activity khác. URL cũ của đúng đề Shops chuyển sang URL chính thức.

## Bằng chứng

- 199 test Writing, 60 test handout và syntax check đạt trên revision phát hành.
- AI thật: execution `2961532`, `2961533`, `2961537`: đoạn sạch 0 thẻ, đoạn có lỗi 2 thẻ, Topic sentence đạt; đọc lại đúng bản đã lưu.
- Browser HTTPS thật: HV/GV, 1440/390px, thẻ nhận xét/pager, reload/tab mới và đăng xuất chung đạt với hồ sơ giả. Màn chọn lớp chính thức đúng 24/23/23, không lộ lớp thử; không mở/nộp/chấm bài thay học viên thật.
- DB runtime bị từ chối kết nối database ngoài; callback sai key/lease không đổi dữ liệu; writer từ chối sai offset và replay giữ cùng ID/version; lease hết hạn được khôi phục; worker restart và trở lại idle, queue 0.
- Bốn workflow Writing 56–67 giữ nguyên phiên bản. Đăng ký SSO chỉ thêm nguồn Shops, giữ cấu hình các nguồn cũ.
- Google thật đã được Đức xác nhận ở bản duyệt. Bản chính thức đã kiểm nút Google trên origin thật, cùng client ID, quyền tài khoản và bridge/restore/logout bằng hồ sơ giả. Chưa lặp lại đăng nhập Google thật trên URL mới: công cụ trình duyệt người dùng báo lỗi runtime assets; không coi phiên giả là Google thật.

Kho biên nhận riêng: `C:/Users/ADMIN/Documents/Codex/shops-handout-preview-20261024/production-private/` và release VPS; không đưa roster/token/live workflow JSON lên repo public. Bản backup đầu tiên `/opt/izone-shops-writing/backups/initial-open-20261024.dump`. Đây là backup một lần, không phải bằng chứng đã có lịch backup định kỳ.

## Quay lui

Giữ database và mọi bài mới; quay image/code của Shops riêng. Không mở lại backend Shops cũ để nhận bài sau khi backend riêng đã có bài mới; không restore database phiên chung hoặc ghi đè bài để quay code. Container API trước bản vá hàng chờ và broker trước khi thêm Shops được giữ để đối chiếu. Main Pages local đang có file task khác chưa commit, được giữ nguyên; bản remote đã phát hành.
