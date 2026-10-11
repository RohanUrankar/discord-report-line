-- 001_init: every table in DESIGN §9. Forward-only; the runner wraps this file in one transaction.
--
-- Enum CHECK lists below must equal the tuples in packages/shared/src/enums.ts. The drift test
-- (migrate.test.ts) reads them back from the live database and fails if the two differ.

-- A server the bot is in. Created on first sight of an interaction, so name, channel and webhook are
-- all optional until an admin sets them on the dashboard. mirror_webhook_enc holds AES-256-GCM ciphertext
-- (iv + tag + data); the key lives in env only (DESIGN §9, "Secrets at rest").
CREATE TABLE guild (
  id                 text        PRIMARY KEY,
  name               text,
  mirror_webhook_enc bytea,
  post_channel_id    text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_guild (
  admin_id uuid NOT NULL REFERENCES admin (id) ON DELETE CASCADE,
  guild_id text NOT NULL REFERENCES guild (id) ON DELETE CASCADE,
  PRIMARY KEY (admin_id, guild_id)
);

CREATE TABLE session (
  id         text        PRIMARY KEY,
  admin_id   uuid        NOT NULL REFERENCES admin (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX session_expires_at_idx ON session (expires_at);

-- id is Discord's interaction id and the dedupe key: INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id.
CREATE TABLE interaction (
  id           text        PRIMARY KEY,
  guild_id     text        NOT NULL REFERENCES guild (id),
  channel_id   text        NOT NULL,
  user_id      text        NOT NULL,
  type         integer     NOT NULL,
  command_name text,
  custom_id    text,
  options      jsonb,
  status       text        NOT NULL
    CONSTRAINT interaction_status_check
    CHECK (status IN ('answered', 'deferred', 'followed_up', 'fallback_posted', 'failed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interaction_guild_created_idx ON interaction (guild_id, created_at DESC);

-- The outbox. One job per interaction (unique interaction_id), committed in the same transaction.
-- interaction_token is a 15-minute credential: its own column, never indexed, cleared when the job ends.
CREATE TABLE job (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id    text        NOT NULL UNIQUE REFERENCES interaction (id),
  guild_id          text        NOT NULL REFERENCES guild (id),
  kind              text        NOT NULL
    CONSTRAINT job_kind_check CHECK (kind IN ('report', 'component')),
  interaction_token text,
  token_expires_at  timestamptz,
  status            text        NOT NULL DEFAULT 'pending'
    CONSTRAINT job_status_check CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempts          integer     NOT NULL DEFAULT 0,
  next_run_at       timestamptz NOT NULL DEFAULT now(),
  claimed_at        timestamptz,
  last_error        text
);
CREATE INDEX job_status_next_run_idx ON job (status, next_run_at);

-- One row per outbound call. target says which call it was ("Slack 503" vs "Discord 401").
CREATE TABLE job_attempt (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid        NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  attempt_no  integer     NOT NULL,
  target      text        NOT NULL
    CONSTRAINT job_attempt_target_check
    CHECK (target IN ('tag', 'mirror', 'followup', 'fallback')),
  outcome     text        NOT NULL
    CONSTRAINT job_attempt_outcome_check CHECK (outcome IN ('success', 'retryable', 'fatal')),
  http_status integer,
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX job_attempt_job_no_idx ON job_attempt (job_id, attempt_no);

-- What the bot did about an interaction, and the step markers the worker resumes from (§9, §11.3):
-- llm_tag IS NOT NULL = tagged; mirror_status = 'sent' = mirrored.
CREATE TABLE action (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id text        NOT NULL UNIQUE REFERENCES interaction (id),
  guild_id       text        NOT NULL REFERENCES guild (id),
  type           text        NOT NULL
    CONSTRAINT action_type_check CHECK (type IN (
      'report', 'status', 'disabled', 'unknown_command', 'acknowledged', 'escalated')),
  summary        text,
  llm_tag        text,
  mirror_status  text        NOT NULL
    CONSTRAINT action_mirror_status_check
    CHECK (mirror_status IN ('pending', 'sent', 'failed', 'skipped')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE command_rule (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id     text        NOT NULL REFERENCES guild (id) ON DELETE CASCADE,
  command_name text        NOT NULL
    CONSTRAINT command_rule_command_name_check CHECK (command_name IN ('status', 'report')),
  config       jsonb       NOT NULL,
  enabled      boolean     NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT command_rule_guild_command_key UNIQUE (guild_id, command_name)
);
