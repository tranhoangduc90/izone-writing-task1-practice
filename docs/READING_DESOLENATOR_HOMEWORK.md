# Reading Homework — The Desolenator

Mã mới theo tiêu đề: `67-reading-the-desolenator`. Đường Pages dự kiến:
`reading-skills67/the-desolenator/`. Mã `67-reading-01` chỉ xác định nguồn
CTA cũ; không đổi các lượt, kết quả hoặc Docs lịch sử sang mã mới.

Bài có phần luyện nén cấp 1 với ChatGPT, sau đó 5 Heading C–G và 10 ô nén
hai cấp. Giữ A–B và ví dụ đoạn A của tài liệu. Bộ chấm đọc exact snapshot
workflow `x7BRN0424aMOSCs1`: dùng nguyên key, rubric, chuẩn hóa và ngưỡng
12/15; không đưa key hoặc snapshot vào Pages/source public.

## Cách nối

- `web-headings-grader.js` bọc bộ chấm CTA, kiểm/bổ sung đúng trường và ID,
  kiểm nội dung rồi mới hoàn tất. Intent, response, checkpoint và lease dùng
  kho Reading hiện hành. Timeout chưa rõ không gọi lại mù; 429/5xx hoãn.
- `web-share-practice.js` dùng bản ghim reader và recognizer từ Speaking 67.
  Link chỉ được nhận sau khi đọc và kiểm đúng hội thoại. Bài gốc có ba cách
  dừng: vượt level sau SOS đầu tiên, xong level 5 không SOS hoặc Mercy Rule.
  Lời chatbot hoàn tất cả bài vẫn được nhận theo policy Speaking.
- Nháp, Share hiện tại và lịch sử tách theo chủ/lớp/mã/version. Đổi link đang
  kiểm không nhận response cũ; unknown giữ đối soát. Mỗi attempt giữ snapshot
  Share được công nhận lúc nộp; thay link sau không thay bản nộp cũ.
- `web-headings-lesson.js` thêm một lesson vào runtime Homework hiện hành.
  Không dựng dịch vụ hay cơ sở dữ liệu riêng cho từng lesson. Worker chấm
  phải giữ `jobScope` đã có ở live baseline.
- Homework ghi tiến độ Share ngay khi công nhận, rồi tiến độ Reading theo
  bản nộp. Giữ ô **TÌNH TRẠNG NỘP BÀI READING**, chữ/link tay, sequence,
  revision và đọc lại; GV chỉ xem. Chưa có bản Homework thì giữ hàng chờ.

Migration mới chỉ thêm ba bảng `web_share_practice`, lịch sử và snapshot
theo attempt. Không sửa/xóa bài, nháp hoặc kết quả cũ. Danh sách lớp lấy mới
từ nguồn K67 hiện hành khi phát hành, gồm lớp roster rỗng.

## Baseline và kiểm

Live Reading hiện dùng image Green roofs/TFNG/SSO/queue ngày 29/10. Gói
`backend/ops/releases/reading-desolenator-20261029/live-compat.patch` áp
đúng baseline đã đọc lại sau khi Green roofs phát hành; không lấy toàn main đè image đang chạy. Kiểm hash và
đối chiếu lại nếu chat khác đã thêm bài. Quay lui code/config riêng; không
restore database hoặc xóa bảng/lịch sử.

Kiểm mới: `backend/test/reading67-headings.test.js` dùng snapshot riêng qua
`READING_HEADINGS_SNAPSHOT`; SQL PGlite với người giả, provider giả và
reader giả. Pages có `tests/desolenator-homework-browser.mjs`: ba viewport,
15 ô, Heading ở phải, 18px, phản hồi/chỉ xem, điều hướng sửa, ba nhịp cập
nhật nền giữ DOM/focus/scroll. Một hành trình trên localhost dùng API/SQL
thật và AI/Share giả kiểm lưu → nộp → feedback → sửa → reload.

Kho tác vụ riêng trên máy Đức: `E:/Codex-Data/reading01-desolenator-20261029/`.
Ở đó có exact backup, nội dung/private config, runtime overlay, log và ảnh.
Không đưa kho này vào Pages hoặc commit snapshot có credential.

Trạng thái trước duyệt phát hành: local đã chạy; chưa phát hành production,
chưa kiểm AI/Google/Docs thật hoặc Classroom cho bài mới. Registry CTA có
candidate chỉ bổ sung mã theo tiêu đề; bộ chấm CTA cũ không thay đổi.

Kết quả ghép với main mới: Desolenator UI 12/12, Green roofs UI 12/12;
native Materials/GV 46/46; Grader Green roofs 6/6; bộ backend bị tác động
46/46 và một vòng API/SQL local đạt. Suite backend trước ghép đạt 480,
8 skip, 0 lỗi; không coi các fixture này là đã gọi AI/Google thật.
Một ca Green roofs đọc vị trí trước requestAnimationFrame của điều hướng;
chờ điều hướng xong rồi đo vẫn giữ DOM/cuộn qua ba nhịp polling, không sửa
hành vi sản phẩm để làm test đạt. Snapshot SSH được truyền base64 để giữ
nguyên byte trước khi đối chiếu hash; không chuẩn hóa ngầm bản chấm ghim.

## Phát hành 29/10/2026

Đức đã duyệt Git và production trong chat. Pages PR360, backend PR71 và
repo điều phối PR262 đã nhập main. URL học viên:
https://tranhoangduc90.github.io/izone-ai-team-pages/reading-skills67/the-desolenator/?server=1
URL GV cùng thư mục, file `teacher.html`. Mở đủ 13 lớp đang học/chờ mở
theo ERP qua Metabase lúc 08:07 UTC, gồm lớp roster rỗng; không mở lớp đã
hoàn thành chỉ vì còn trong danh sách quyền cũ.

Image hiện hành `izone-reading-homework:desolenator-20261029-v2`; module
và config đã đối chiếu byte. Backup tại `/opt/izone-reading-desolenator-20261029`
và thư mục `-v2`; container trước chuyển được giữ, dữ liệu nháp/lượt/kết quả
cũ nguyên vẹn. Ba bảng mới được cấp đúng quyền cho app, không restore DB.

AI thật đạt 15/15 trên đáp án chuẩn giả lập. Lần đầu bước review trả khung
Markdown/thiếu trường; lỗi không được đưa ngược vào prompt nên lặp lại.
PR72 bổ sung hướng dẫn JSON thuần/đủ mảng và phản hồi lỗi cụ thể, giữ
parser nghiêm. Ca hồi quy RED/GREEN, 12/12 Headings/Share và 27/27 test
backend bị tác động đạt; checkpoint cũ hoàn tất mà không gọi lại bước đầu.
Bộ đọc Share thật đọc được hai tin của link mẫu, recognizer thật chấp nhận
hội thoại hoàn tất giả lập. Không tạo/nộp/chấm lượt học viên thật.

CTA vẫn active, settings/trigger/connection/node khác giữ nguyên. Execution
canary 3082537 chạy node native trả đúng mã, externalWrites=0. Workflow thử
URVr5yKjDUakeOXE inactive, tag Codex tạo/Tạm thời, owner reading-desolenator-20261029,
hạn giữ 30/10/2026 08:00 UTC; archive còn chờ quyền riêng, không tự chạy.

Docs nguồn đã đổi mã/CTA, bổ sung ô trạng thái READING; planner đọc lại
verified, 0 request. Docs thử cũng ghi/readback và lặp lại 0 request. Phiên
GV thật được khôi phục bằng broker materials và thấy đủ 13 lớp; cửa HV
kiểm trong context sạch. Đây không phải xác nhận đã giao Classroom hay
đã thử một bản nộp của học viên thật.
