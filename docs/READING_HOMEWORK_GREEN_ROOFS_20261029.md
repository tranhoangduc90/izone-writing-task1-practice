# Reading Homework — Green roofs

Mã bài mới `67-reading-green-roofs`, version `green-roofs-nen-2-cap-20261029-v1`.
Tên bài quyết định mã; không dùng số thứ tự Homework làm mã mới. Các ID target
`l4.*` giữ nguyên để nối bộ chấm hiện có, không là mã bài giao học viên.

Nguồn bài là Google Docs do Đức cung cấp, tab `t.0`. Bài có 5 đoạn A–E, hai
nhóm Choose TWO cho câu 10–13 và 10 ô nén hai cấp độ. Giữ ngưỡng 12/14 như
profile hiện hành. Đề/key/rubric và snapshot nằm trong kho private, ngoài Pages.

Catalog hiện hành của mã legacy `67-reading-02` trỏ bộ chấm Green roofs riêng.
Adapter web lấy snapshot đó, giữ chấm multiset không phân biệt thứ tự, không
tính một lựa chọn lặp thành hai đáp án đúng. Rubric nén gốc được ghim cùng cấu
hình audit theo ý; giữ cách đại khái hóa đã chấp nhận và ý phục vụ câu hỏi C/E.
Vòng kiểm/bổ sung dùng hàng bền chung: đủ audit, giải thích và hướng sửa mới
hoàn tất; checkpoint, lease, nháp, lịch sử và Docs vẫn theo mã/version/người/lớp.

Runtime dùng cơ chế additional lessons của Reading Homework đã phát hành với
TFNG. Main còn thiếu gói nguồn đó nên nhánh này tích hợp nguồn phụ thuộc và giữ
các điểm mở rộng Listening mới hơn khi giải quyết xung đột. Phát hành dự kiến
chỉ overlay ba module trên image live, thêm cấu hình bài và mount private. Không
build toàn bộ main hoặc chạy migration của sản phẩm khác.

ERP ngày 29/10 có 13 lớp khóa 6.0–7.0 đang học hoặc chờ khai giảng; cấu hình
được lấy từ ERP rồi đối chiếu authority hiện hành. Lớp không có roster approved
phải báo thiếu mapping, không tạo học viên để thử. Không tự giao Classroom.

Kiểm đã thực hiện: 91 ca backend không trùng; 12 ca UI của Green roofs trên ba
viewport; 24 ca Materials/phiên và 5 viewport TFNG. AI thật dùng bài làm mẫu giả
lập đã hoàn tất 14/14 mục qua ba vòng, gồm bổ sung và review. Google Docs thử
đã dùng planner thật để ghi CTA/trạng thái, đọc lại verified và lần hai 0 lệnh,
giữ dòng tay. Các kiểm này không là bài nộp học viên hoặc Classroom thật.

Candidate CTA chỉ mở thêm mã theo tiêu đề tại một Code node. Có 11 ca nhận diện
và chống mơ hồ, 19 Code node biên dịch đạt, settings/trigger giữ nguyên. Validator
n8nctl còn 25 chẩn đoán giống nguyên bản live; không thêm chẩn đoán mới, không
nâng typeVersion hoặc đổi tham số đang chạy để làm im cảnh báo.

Kho riêng: `E:/Codex-Data/reading02-green-roofs-20261029/`. Có snapshot nguồn,
config, audit, bản đóng gói, kiểm, checkpoint AI và Docs thử. Trước chuyển phải
đọc lại image/config/source live để giữ bài được task khác thêm đồng thời.
Quay code/config đúng gói; không restore database hoặc chấm lại bài cũ.

Trạng thái hiện tại: chuẩn bị xong, chưa phát hành backend hoặc cập nhật CTA
production. Git, phát hành và mở bài được báo riêng khi thực sự hoàn tất.
