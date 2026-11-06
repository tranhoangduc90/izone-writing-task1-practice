# Reading/Listening 67: lớp mới tự mở

Theo yêu cầu Đức ngày 06/11/2026, cả Homework và thực chiến mở cho toàn khóa 67, gồm lớp mới trong khoảng 15 phút. Homework production mặc định bật `autoOpenCourse67`; bài hoặc cả sản phẩm chỉ giữ phạm vi riêng khi có cấu hình rõ `autoOpenCourse67:false`. Local fixture không bật nguồn động.

Nguồn `/v1/homework/class-scope` chỉ nhận ERP course 5 đã được quan sát, Classroom mapping approved và mã lớp khớp. Giữ lớp đã từng học; loại lớp chưa bắt đầu. Học viên và giảng viên vẫn phải qua kiểm UUID, đăng ký đang học và quyền hiện hành. Không tự duyệt pending. Hai lớp 1333/1345 giữ ngoại lệ ERP native cũ; không mở rộng ngoại lệ sang lớp mới.

Hai Homework chia sẻ cache 30 giây và gộp request đồng thời. Danh sách lớp, owner policy, CTA đầu tiên, URL của worker và document entry đều đọc phạm vi mới, không cần restart. Nguồn sai, cũ hoặc lỗi trả 503; hàng Docs tiếp tục retry khi nguồn tạm lỗi. Hai sản phẩm thực chiến đã đọc nguồn động nên không đổi image. Không tự tạo Classroom hoặc chọn tài khoản mâu thuẫn.

## Runtime

- Context source: `da83097fa97dbaca12be03301930db9492dea72fd2214ba063c97b7d5a9217dc`.
- Reading Homework: `dfe1a32b9b81874d137e693d56e1717c265574d58d9e85f638033efea47d5e0d`.
- Listening Homework: `6a9a8b5884e3b24795d96657cf3b3ec6b19093da0f0649dab7189939e22c25af`.

Chỉ ghép delta vào đúng bản live, giữ SSE, compact ACK, coordinator và ERP eligibility đang chạy. Hai patch kèm theo ghi đúng delta; không dùng toàn canonical main để thay image có overlay lịch sử. Config, env, mount, mạng và quyền Docker giữ nguyên. Backup container gốc có hậu tố `-before-rl67-auto-scope-20261106`; vòng CTA có thêm `-r2`. Quay runtime giữ DB hiện hành, không restore đè bài/nháp/phiên.

## Kiểm

80 ca canonical đạt: thêm lớp sau khởi tạo; 11 consumer dùng chung nguồn; opt-out; lớp khác, pending, bảo lưu; nguồn cũ, sai hash, lỗi; owner/Docs sai chủ; URL CTA và retry. Regression trên module exact live của cả hai Homework cũng đạt. Audit API 22 bài × 11 lớp: 242 roster checks, tổng 275 GET đều đạt. Không đăng nhập, bắt đầu, nộp hoặc chấm hộ học viên thật.

Migration và monitor: [Issue 80](https://github.com/tranhoangduc90/izone-mapping-database/issues/80). Lịch native và bản sửa xung đột approved ở `n8n-workflows/workflows/rl67-auto-scope-20261106` của repo izone-AI-team. Bằng chứng riêng tư/backup ở `C:/Users/ADMIN/Documents/Codex/rl67-auto-scope-20261106` và `/opt/izone-rl67-auto-scope-20261106` trên máy chủ.
