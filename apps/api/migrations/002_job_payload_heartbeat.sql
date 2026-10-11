-- 002: what Step 3 needs beyond the Step 2 schema (DESIGN rev 5, §9).
--
-- job.payload is the rule snapshot taken when the report was deferred (reply text, ephemeral, mirror,
-- the report itself), so the worker never re-reads a rule an admin may have edited since. It holds no
-- credential: the interaction token has its own column.
ALTER TABLE job ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb;

-- One row, upserted by the worker on every tick. /status reads it as "Worker last active N s ago".
CREATE TABLE worker_heartbeat (
  id      text        PRIMARY KEY,
  beat_at timestamptz NOT NULL
);
