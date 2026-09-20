BEGIN;

-- Dữ liệu nhận vào: mã cặp bài và dấu vân tay HMAC của từng từ trong bài viết.
-- Việc chính: cho phép tìm nội dung mà không lưu bài viết rõ hoặc từ khóa rõ trong database.
-- Kết quả: dashboard tìm nhanh ứng viên rồi API mới giải mã và kiểm tra quyền ở server.
-- Khi lỗi: transaction rollback, luồng chấm hiện tại và dữ liệu đã mã hóa giữ nguyên.
CREATE TABLE IF NOT EXISTS writing_flow.pair_search_token (
  pair_id uuid NOT NULL REFERENCES writing_flow.pair(pair_id) ON DELETE CASCADE,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash)=32),
  PRIMARY KEY (pair_id,token_hash)
);
CREATE INDEX IF NOT EXISTS writing_pair_search_token_lookup_idx
  ON writing_flow.pair_search_token (token_hash,pair_id);
GRANT SELECT,INSERT ON writing_flow.pair_search_token TO writing_practice_api;

-- Bổ sung liên tục dữ liệu Classroom cho nguồn chuyển tiếp Lark khi Docs ID chỉ khớp một nguồn.
-- Bao gồm tên homework để dashboard hiển thị giống công thức HYPERLINK của Lark Base.
WITH classroom_candidate AS (
  SELECT source_id,homework_file_id,display_name,student_name,teacher_names,classroom_url,
         source_status,source_created_at,source_updated_at,metadata,
         count(*) OVER (PARTITION BY homework_file_id) AS match_count
  FROM writing_flow.source_record
  WHERE source_type='google_classroom' AND homework_file_id IS NOT NULL
), unique_classroom AS (
  SELECT * FROM classroom_candidate WHERE match_count=1
)
UPDATE writing_flow.source_record AS legacy
SET display_name=coalesce(nullif(legacy.display_name,''),source.display_name),
    student_name=coalesce(nullif(legacy.student_name,''),source.student_name),
    teacher_names=CASE WHEN cardinality(legacy.teacher_names)=0
      THEN source.teacher_names ELSE legacy.teacher_names END,
    classroom_url=coalesce(nullif(legacy.classroom_url,''),source.classroom_url),
    source_status=coalesce(nullif(legacy.source_status,''),source.source_status),
    source_created_at=coalesce(legacy.source_created_at,source.source_created_at),
    metadata=legacy.metadata || jsonb_build_object(
      'classroomBackfillSourceId',source.source_id::text,
      'classroomBackfilledAt',to_jsonb(now())),
    updated_at=now()
FROM unique_classroom AS source
WHERE legacy.source_type='lark_homework'
  AND legacy.homework_file_id=source.homework_file_id
  AND (nullif(legacy.display_name,'') IS NULL
    OR nullif(legacy.student_name,'') IS NULL
    OR cardinality(legacy.teacher_names)=0
    OR nullif(legacy.classroom_url,'') IS NULL
    OR nullif(legacy.source_status,'') IS NULL
    OR legacy.source_created_at IS NULL);

COMMIT;
