-- 004: Acknowledge / Escalate clicks (DESIGN §5.5, rev 7).
--
-- A click is its own interaction with its own ACTION row (type 'acknowledged' or 'escalated'). The report's
-- state is derived from those rows, but nothing linked a click's ACTION to the report it was about: the
-- report id only existed inside interaction.custom_id text, which cannot carry a foreign key or a unique
-- constraint. report_id is that link, so the database itself can refuse a second acknowledge of the same
-- report (unique index) and a state lookup is an indexed join, not a string match over the log.
ALTER TABLE action ADD COLUMN report_id text REFERENCES interaction (id);

-- Exactly the click rows have a report_id.
ALTER TABLE action ADD CONSTRAINT action_report_id_check
  CHECK ((type IN ('acknowledged', 'escalated')) = (report_id IS NOT NULL));

-- A report is acknowledged at most once and escalated at most once, whoever clicks and however they race.
CREATE UNIQUE INDEX action_report_state_key ON action (report_id, type) WHERE report_id IS NOT NULL;
