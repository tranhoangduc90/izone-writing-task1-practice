-- psql -X -v session_ref=<session UUID> -f tools/save-diagnostics.sql
-- Use a read-only connection to handout_writing67. No student text is returned.
SELECT saved.session_ref, saved.event_at, (saved.details->>'version')::int AS draft_version,
       field.name AS field, saved.details->'saveEvidence'->>'operationId' AS operation_id,
       lengths.value->'before' AS before_length, lengths.value->'after' AS saved_length,
       display.details->>'build' AS frontend_build,
       CASE WHEN display.event_key IS NOT NULL THEN 'ui_became_empty' END AS browser_observation,
       CASE
         WHEN lengths.value IS NULL THEN 'not_recorded'
         WHEN (lengths.value->>'before')::int>0 AND (lengths.value->>'after')::int=0 THEN 'server_cleared'
         WHEN (lengths.value->>'after')::int<(lengths.value->>'before')::int THEN 'server_shortened'
         WHEN (lengths.value->>'before')::int>0 THEN 'server_updated'
         ELSE 'server_added'
       END AS server_change
FROM handout67.activity_event saved
CROSS JOIN LATERAL jsonb_array_elements_text(saved.details->'fields') AS field(name)
LEFT JOIN LATERAL (SELECT saved.details->'saveEvidence'->'fieldLengths'->field.name AS value
                   WHERE saved.details->'saveEvidence'->>'version'='1') lengths ON true
LEFT JOIN handout67.activity_event display ON display.session_ref=saved.session_ref
  AND display.event_key=saved.session_ref::text||':save-display:'||(saved.details->>'version')||':'||field.name
  AND display.kind='save_display_empty' AND display.details->>'schemaVersion'='1'
WHERE saved.session_ref=:'session_ref'::uuid AND saved.kind='responses_saved'
ORDER BY draft_version, field.name;
