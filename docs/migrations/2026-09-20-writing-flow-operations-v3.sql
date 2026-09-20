BEGIN;

-- Dữ liệu nhận vào: mapping lớp đã duyệt và trạng thái lớp do Portal đồng bộ.
-- Việc chính: bổ sung trạng thái đủ để chọn lớp vận hành, retry riêng từng lớp
-- và tìm kiếm dashboard mà không đọc hoặc ghi Lark Base.
-- Kết quả: lớp đang học được quét; lớp hoàn thành và lớp chưa rõ được tách riêng.
-- Khi lỗi: transaction rollback, lịch quét và dữ liệu Writing hiện tại giữ nguyên.

ALTER TABLE writing_flow.class_registry
  ADD COLUMN IF NOT EXISTS erp_course_class_id bigint,
  ADD COLUMN IF NOT EXISTS mapping_status text,
  ADD COLUMN IF NOT EXISTS class_status text,
  ADD COLUMN IF NOT EXISTS eligibility_reason text,
  ADD COLUMN IF NOT EXISTS scan_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_mapping_sync_at timestamptz;

ALTER TABLE writing_flow.class_registry
  DROP CONSTRAINT IF EXISTS class_registry_scan_status_check;
ALTER TABLE writing_flow.class_registry
  ADD CONSTRAINT class_registry_scan_status_check
  CHECK (scan_status IN ('pending','scanning','succeeded','failed','paused','needs_review'));

ALTER TABLE writing_flow.class_registry
  DROP CONSTRAINT IF EXISTS class_registry_scan_attempt_count_check;
ALTER TABLE writing_flow.class_registry
  ADD CONSTRAINT class_registry_scan_attempt_count_check
  CHECK (scan_attempt_count BETWEEN 0 AND 3);

CREATE INDEX IF NOT EXISTS writing_class_operational_idx
  ON writing_flow.class_registry (enabled,class_status,mapping_status,class_code);

-- Chỉ ghép lịch sử Lark với nguồn Classroom khi Google Docs ID trỏ duy nhất tới một nguồn.
-- Nhờ vậy dashboard cũ có tên học viên/Classroom/TRCC khi dữ liệu đã tồn tại ở nguồn mới,
-- nhưng không tự đoán nếu một tài liệu xuất hiện ở nhiều submission.
WITH classroom_candidate AS (
  SELECT source_id,homework_file_id,student_name,teacher_names,classroom_url,
         source_status,source_created_at,source_updated_at,metadata,
         count(*) OVER (PARTITION BY homework_file_id) AS match_count
  FROM writing_flow.source_record
  WHERE source_type='google_classroom' AND homework_file_id IS NOT NULL
), unique_classroom AS (
  SELECT * FROM classroom_candidate WHERE match_count=1
)
UPDATE writing_flow.source_record AS legacy
SET student_name=coalesce(nullif(legacy.student_name,''),source.student_name),
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
  AND (nullif(legacy.student_name,'') IS NULL
    OR cardinality(legacy.teacher_names)=0
    OR nullif(legacy.classroom_url,'') IS NULL
    OR nullif(legacy.source_status,'') IS NULL
    OR legacy.source_created_at IS NULL);

-- Chuẩn hóa “Thời điểm xong” bằng chính lúc bước ghi link đã thành công.
UPDATE writing_flow.pair AS pair
SET finished_at=deliver.completed_at
FROM writing_flow.stage_result AS deliver
WHERE pair.finished_at IS NULL AND deliver.pair_id=pair.pair_id
  AND deliver.stage_key='deliver' AND deliver.status='succeeded'
  AND deliver.completed_at IS NOT NULL;

CREATE OR REPLACE FUNCTION writing_flow.normalize_search(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT trim(regexp_replace(
    translate(lower(coalesce(value,'')),
      'àáạảãăằắặẳẵâầấậẩẫđèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹ',
      'aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy'),
    '[^a-z0-9]+',' ','g'));
$function$;

GRANT SELECT ON TABLE mapping.classroom_course_mapping TO writing_practice_api;
GRANT SELECT ON TABLE mapping.reviewer_class_access TO writing_practice_api;
GRANT SELECT ON TABLE mapping.reviewer_account TO writing_practice_api;
GRANT EXECUTE ON FUNCTION writing_flow.normalize_search(text) TO writing_practice_api;

COMMIT;
