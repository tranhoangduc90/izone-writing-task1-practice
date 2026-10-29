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

Live Reading có overlay TFNG/SSO/queue chưa nằm hết trong main. Gói
`backend/ops/releases/reading-desolenator-20261029/live-compat.patch` áp
đúng baseline đã đọc; không lấy toàn main đè image đang chạy. Kiểm hash và
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
