BEGIN;
CREATE SCHEMA cta_shared_k67;
CREATE VIEW cta_shared_k67.assignments WITH (security_barrier=true) AS
SELECT id, jsonb_build_object(
  'authorityClassId', definition->'authorityClassId',
  'contentVersion', definition->'contentVersion',
  'classroom', jsonb_build_object(
    'courseId', definition->'classroom'->'courseId',
    'courseWorkId', definition->'classroom'->'courseWorkId',
    'ctaCode', definition->'classroom'->'ctaCode'
  )
) AS definition
FROM public.assignments
WHERE definition->'classroom'->>'ctaCode' ~ '^hw-writing-67-[A-Za-z0-9_-]+$';
REVOKE ALL ON SCHEMA cta_shared_k67 FROM PUBLIC;
REVOKE ALL ON cta_shared_k67.assignments FROM PUBLIC;
GRANT USAGE ON SCHEMA cta_shared_k67 TO k67_cta_writing_reader;
GRANT SELECT ON cta_shared_k67.assignments TO k67_cta_writing_reader;
COMMIT;
