# Nguồn dùng lại từ Speaking 67

Hai module trong thư mục này được sao nguyên từ source cùng chủ sở hữu
`izone-classroom-mapping-review/backend/src/` ngày 29/10/2026:
`speaking-share-reader.js` và `speaking-completion-policy.js`.

Reading chỉ truyền kỹ năng nén cấp 1 làm target. Giữ parser, nguồn Share,
snapshot, nhận diện lời hoàn tất cả bài và kiểm bằng chứng nguyên văn.
Quy tắc dừng riêng của bài Reading nằm ở `../web-share-practice.js`.
Không sửa dịch vụ hoặc cấu hình Speaking. Hash của bản ghim nằm trong
manifest phát hành riêng; nâng bản cần kiểm lại parser và completion.
