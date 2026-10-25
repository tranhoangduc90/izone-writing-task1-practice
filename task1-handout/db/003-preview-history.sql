CREATE TABLE task1_private.history_snapshot (
 id integer PRIMARY KEY CHECK(id=1),captured_at timestamptz NOT NULL,sha256 text NOT NULL CHECK(length(sha256)=64),original_text text NOT NULL
);
REVOKE ALL ON task1_private.history_snapshot FROM PUBLIC;
GRANT SELECT ON task1_private.history_snapshot TO task1_api;
