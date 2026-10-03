-- Dữ liệu nhận vào: cần đóng riêng đề thu nhập; giữ nguyên bài làm và lịch sử.
-- Việc chính: đóng hai scope và activity mới, không xóa bất kỳ bản ghi nào.
-- Kết quả: học viên không mở phiên mới; dữ liệu cũ còn để phục hồi/đối soát.
-- Khi lỗi: transaction rollback; kiểm lại API và database trước thao tác khác.

BEGIN;

UPDATE writing_practice.activity_class_scope AS scope
SET status = 'closed'
FROM writing_practice.activity AS activity
WHERE scope.activity_id = activity.id
  AND activity.slug = 'average-earnings-by-sector-2000-2010'
  AND activity.public_id = 'ed8162c1-2d54-4998-96a8-458fa75d26aa'
  AND scope.class_name_snapshot IN ('CS.070626', 'CS.160826');

UPDATE writing_practice.activity
SET status = 'closed', updated_at = now()
WHERE slug = 'average-earnings-by-sector-2000-2010'
  AND public_id = 'ed8162c1-2d54-4998-96a8-458fa75d26aa';

COMMIT;
