# Prompt Socratic Task 1 — thành quả và giới hạn ngày 25/10/2026

## Gói đã phát hành

Phiên bản `2026-10-25.socratic-v2.5`, 18 prompt = sáu đề × Overview/Outline/Draft. Chỉ API/worker đọc prompt riêng; public frontend và image không chứa template. [Manifest kiểm toàn vẹn](prompt-manifest-20261025.json) ghi slug/chặng/phiên bản/SHA-256, không chứa bài học viên hoặc template. Gói riêng: `E:/Codex-Data/private-evals/task1-sw-prompts-v2-20261025/prompt-package.json`; template tại các path của gói, bản active trong DB riêng `task1_private.prompt`.

Gói cuối dùng Overview r4 và Outline/Draft r5, nhất quán theo chặng; không chọn response tốt nhất theo từng ca. Không sửa snapshot/lượt chấm cũ hoặc tự suy phiên bản prompt của execution lịch sử từ snapshot audit.

## Các thay đổi sư phạm

- Overview: kiểm nhận xét lớn theo dữ kiện đúng, đơn vị/đối tượng/phạm vi; chấp nhận xấp xỉ có căn cứ và diễn đạt tương đương. Không bắt thêm chi tiết hoặc hình thức không thiết yếu khi mục tiêu đã đạt.
- Outline: kiểm cách nhóm và dẫn chứng đúng với logic thân bài; chấp nhận cách chia hợp lý khác mẫu, không ép khuôn câu hoặc số neo. Phân biệt largest/majority, phần trăm/điểm phần trăm và nhãn full-time theo đề.
- Draft: phản hồi tiếng Việt, định vị chỗ cần suy nghĩ, hỏi Socratic và yêu cầu người học tự sửa; giữ phần đúng. Không tạo câu/đoạn tiếng Anh sửa sẵn, không trả outline thay học viên và không cần báo cáo LMS.
- Lỗi gọi AI/đầu ra thiếu hoặc bị cắt là lỗi kỹ thuật, không tăng chuỗi lỗi học thuật. Giới hạn 120 đơn vị cách trắng ở Overview, 150 ở Outline/Draft; bộ chặn không viết lại đáp án để rút gọn. Năm ca quá dài trong bộ cuối được giữ khối phản hồi đầu còn đầy đủ, nên phải xem cả output thô và output hiển thị.

## So sánh trước–sau

30 ca hồi quy có chủ đích từ bài cũ: mỗi chặng 10 ca. Giữ cùng bài và lịch sử, dùng cùng `gemini-3.1-pro-preview`; phân biệt ba cột phản hồi lịch sử, prompt snapshot cũ chạy lại và gói mới. Nhãn kỳ vọng do Codex lập trước lượt so sánh; bộ cuối được chỉnh bằng chính các ca này, chưa có chấm mù độc lập hoặc tập giữ kín.

| Chỉ số | Trước | Sau |
| --- | ---: | ---: |
| Overview/Outline đúng nhãn kỳ vọng | 14/20 | 20/20 |
| Bắt oan trong 11 ca đủ tốt | 5 | 0 |
| Bỏ lọt trong 9 ca có lỗi thật | 1 | 0 |
| Draft có câu/đoạn tiếng Anh viết thay | 9/10 | 0/10 |
| Response thô vượt giới hạn dài | 15/30 | 5/30 |
| Thời gian trung vị mỗi lời gọi (giây) | 26,383 | 15,488 |
| Tổng token bộ so sánh chính | 225.450 | 130.092 |

126 lời gọi trong các vòng chỉnh prompt; thêm ba ca backend AI và ba ca mở rộng Draft, tổng 132 trước giai đoạn VPS. Không cộng ba ca mở rộng vào bảng chính vì thiếu phản hồi học thuật cũ đọc được. Một ca mở rộng còn nêu ba điểm trong một khối: yêu cầu ưu tiên một lỗi chưa được bảo đảm tuyệt đối.

Đã replay 30/30 response qua worker → SQL → HTTP, đúng attempt/hash; ba ca AI backend đầu và ba ca mở rộng đều hoàn tất/đọc lại đúng. Sau đó lớp QA production kiểm bốn lượt qua backend thật, giữ riêng trong biên nhận cutover, không trộn vào phép so sánh học thuật 30 ca.

## Kho bằng chứng và cách dùng tiếp

Kho riêng nêu trên giữ `cases.json`, `CRITERIA.md`, request/response/hash/model/token, mọi vòng chưa đạt, `comparison.json`, `backend-replay.json`, `backend-real-ai.json`, `backend-extensions-ai.json` và `SO-SANH-TRUOC-SAU.html`. Audit trước thay đổi ở `E:/Codex-Data/private-evals/task1-sw-20261024`; preview và cutover ở hai thư mục `task1-vps-preview-20261025`, `task1-cutover-20261025`. Không đưa các payload, roster, mã PIN hoặc template riêng lên Git public.

Các con số trên là kết quả hồi quy trong phạm vi đã kiểm, không phải độ chính xác trên mọi bài, độ ổn định qua nhiều lần sinh hoặc bằng chứng người học tiến bộ dài hạn. Lần sửa sau cần giữ đúng ca, dữ kiện, hash và lịch sử; bổ sung ca mới/chấm mù khi muốn kết luận tổng quát. Không chấm lại bài thật chỉ để tái tạo báo cáo.
