-- Applied by task1_owner in the product's own cluster/database only.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE sw_task1 FROM PUBLIC;
GRANT CONNECT ON DATABASE sw_task1 TO task1_api;
GRANT USAGE ON SCHEMA writing_practice,task1_private TO task1_api;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA writing_practice TO task1_api;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA writing_practice TO task1_api;
GRANT SELECT ON task1_private.teacher_grant,task1_private.prompt,task1_private.attempt_context TO task1_api;
GRANT INSERT ON task1_private.attempt_context TO task1_api;
GRANT SELECT,UPDATE ON task1_private.capacity TO task1_api;
GRANT SELECT,INSERT ON task1_private.result_receipt TO task1_api;
REVOKE CREATE ON SCHEMA writing_practice,task1_private FROM task1_api;
