\set ON_ERROR_STOP on

BEGIN;

-- Enums ----------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE workspace_role AS ENUM ('OWNER', 'MEMBER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE board_role AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE attachment_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Identity & Access ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          varchar(254) NOT NULL UNIQUE,
  display_name   varchar(100) NOT NULL,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(100) NOT NULL,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  role          workspace_role NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);

-- Board Collaboration --------------------------------------------------------
CREATE TABLE IF NOT EXISTS boards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          varchar(100) NOT NULL,
  description   varchar(2000),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS boards_workspace_idx ON boards (workspace_id);
CREATE TABLE IF NOT EXISTS board_members (
  board_id  uuid NOT NULL REFERENCES boards(id),
  user_id   uuid NOT NULL REFERENCES users(id),
  role      board_role NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS board_members_user_idx ON board_members (user_id);

CREATE TABLE IF NOT EXISTS board_columns (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id  uuid NOT NULL REFERENCES boards(id),
  name      varchar(100) NOT NULL,
  position  integer NOT NULL,
  UNIQUE (board_id, position)
);

CREATE TABLE IF NOT EXISTS tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id      uuid NOT NULL REFERENCES boards(id),
  column_id     uuid NOT NULL REFERENCES board_columns(id),
  title         varchar(200) NOT NULL,
  description   text NOT NULL DEFAULT '' CHECK (char_length(description) <= 20000),
  assignee_ids  uuid[] NOT NULL DEFAULT '{}',
  due_date      date,
  position      bigint NOT NULL,                             --new cards go last
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1), 
  created_by    uuid NOT NULL REFERENCES users(id),
  updated_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_max_assignees CHECK (cardinality(assignee_ids) <= 10)
);
CREATE INDEX IF NOT EXISTS tasks_board_column_idx ON tasks (board_id, column_id, position);

-- Attachments ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id              uuid NOT NULL REFERENCES tasks(id),
  board_id             uuid NOT NULL REFERENCES boards(id),
  uploaded_by          uuid NOT NULL REFERENCES users(id),
  file_name            varchar(255) NOT NULL,
  content_type         varchar(127) NOT NULL,
  size_bytes           bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144000),   -- 250 MiB
  storage_key          text NOT NULL UNIQUE,
  preview_key          text,                                 -- set by the File Worker for images
  status               attachment_status NOT NULL DEFAULT 'PENDING',
  failure_reason       varchar(32),
  upload_confirmed_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_task_idx  ON attachments (task_id);
CREATE INDEX IF NOT EXISTS attachments_stale_idx ON attachments (status, updated_at)
  WHERE status IN ('PENDING', 'PROCESSING');

-- Transactional outbox (ADR 003) ---------------------------------------------
CREATE TABLE IF NOT EXISTS outbox_events (
  seq           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id      uuid NOT NULL UNIQUE,
  exchange      varchar(100) NOT NULL,
  routing_key   varchar(100) NOT NULL,
  payload       jsonb NOT NULL, 
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events (seq) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_purge_idx   ON outbox_events (published_at)
  WHERE published_at IS NOT NULL;

COMMIT;