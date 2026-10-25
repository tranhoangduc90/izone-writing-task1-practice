# Kiểm chứng bản local ngày 25/10/2026

Trạng thái: **local/candidate đạt phạm vi đã kiểm; chưa phát hành**.

- `npm run check`: cú pháp nguồn và sáu hash vendor khớp revision ghim. Hash vendor chuẩn hóa UTF-8/LF để nhất quán Windows/Linux.
- `node --test test/product.test.mjs`: **16/16 đạt**, không skip. PostgreSQL/PGlite chạy SQL thật, Supertest gọi HTTP thật trong tiến trình local. Có hồi quy cùng Draft cần sửa bị lõi cũ từ chối vì thiếu LMS, bản riêng chấp nhận; không dùng giả lập SQL theo thứ tự query để chứng minh nghiệp vụ.
- 30 ca bài cũ: bộ prompt cũ và bộ cuối gọi cùng Gemini 3.1 Pro preview, giữ nguyên snapshot/lịch sử. Overview/Outline khớp nhãn kiểm 14/20 → 20/20; Draft viết câu/đoạn thay 9/10 → 0/10. Nhãn do Codex đặt, chưa có chấm mù độc lập. Bộ cuối được chỉnh bằng các ca này, nên đây là hồi quy có định hướng.
- Chạy lại 30 response AI thật đã lưu qua worker → SQL → HTTP: **30/30 lưu và đọc lại đúng attempt**, SHA prompt dựng lại khớp request đã thử. Năm response vượt giới hạn được giữ khối đầu; không gọi AI lại hoặc sửa bài học viên để đạt kiểm.
- Gọi AI thật thêm ba ca qua backend riêng, một ca mỗi chặng: **3/3 hoàn tất và HTTP đọc lại đúng phản hồi**. Dùng danh tính fixture trong DB local, giữ nguyên nội dung bài và lịch sử nguồn đã được cho phép. Ba lượt này trước bản vá riêng về hết lease/giới hạn ghi theo học viên; các hàm dựng prompt, gọi AI, ghép job và lưu kết quả của phép thử giữ nguyên. Hai bản vá có hồi quy SQL/HTTP riêng trong bộ 16 ca cuối.

Kho riêng tư trên máy Đức: `E:/Codex-Data/private-evals/task1-sw-prompts-v2-20261025/`, gồm request/response/hash, mọi vòng chỉnh, `comparison.json`, `backend-replay.json`, `backend-real-ai.json`, `backend-tests-final.txt` và trang so sánh. Không đưa bài cũ, roster, prompt riêng hoặc token vào Git.

Chưa kiểm: build/start/restart Docker, PostgreSQL container/đường mạng và quyền CONNECT trên VPS thật, Google thật/broker nguồn Task 1, frontend/thư viện thật, chuyển toàn bộ lịch sử/PIN và tải lớp đông. Kiểm quyền schema/role trên PGlite không thay bằng chứng quyền database/network thật. Xem RUNBOOK để hoàn tất bản thử trước khi xin mở lớp.

Kết quả AI còn có biến thiên: các vòng trung gian từng chặn sai số xấp xỉ hoặc đòi thêm số neo; có phản hồi gợi quá sát đáp án hoặc nêu quy tắc từ vựng quá tuyệt đối. Giới hạn độ dài được kiểm bằng code; không tuyên bố prompt tự tuân thủ 100%. Chưa đo năng lực học viên sau sửa hoặc hiệu quả dài hạn.
