CREATE SCHEMA IF NOT EXISTS sw_roster;

CREATE TABLE IF NOT EXISTS sw_roster.member (
  student_ref uuid PRIMARY KEY,
  erp_class_id bigint NOT NULL CHECK (erp_class_id > 0),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 100),
  name_key text NOT NULL,
  actor_email text NOT NULL,
  origin_product text NOT NULL CHECK (origin_product IN ('task1','task2')),
  origin_activity text NOT NULL,
  origin_class_ref uuid NOT NULL,
  request_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  erp_contact_id bigint CHECK (erp_contact_id > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_email, request_id)
);

CREATE INDEX IF NOT EXISTS sw_roster_active_class_name
  ON sw_roster.member (erp_class_id, name_key) WHERE active;

CREATE UNIQUE INDEX IF NOT EXISTS sw_roster_active_class_contact
  ON sw_roster.member (erp_class_id, erp_contact_id) WHERE active AND erp_contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sw_roster.invitation (
  invitation_ref uuid PRIMARY KEY,
  student_ref uuid NOT NULL REFERENCES sw_roster.member (student_ref),
  actor_email text NOT NULL,
  request_id uuid NOT NULL,
  product text NOT NULL CHECK (product IN ('task1','task2')),
  activity_slug text NOT NULL,
  class_ref uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  credential_hash text UNIQUE,
  UNIQUE (actor_email, request_id),
  CHECK ((redeemed_at IS NULL) = (credential_hash IS NULL))
);

CREATE TABLE IF NOT EXISTS sw_roster.delivery (
  student_ref uuid NOT NULL REFERENCES sw_roster.member (student_ref),
  product text NOT NULL CHECK (product IN ('task1','task2')),
  targets jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_ref, product)
);

REVOKE ALL ON SCHEMA sw_roster FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA sw_roster FROM PUBLIC;
