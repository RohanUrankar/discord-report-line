-- 003: a server has at most one managing admin (DESIGN rev 6, ADR-0003 consequences).
--
-- Connecting a server is first-claim-wins. The rule is enforced by the primary key itself, so two admins
-- claiming the same server at the same moment cannot both succeed: the database picks one winner.
-- guild_id alone becomes the key (the only conflict target the claim statement needs); the old
-- (admin_id, guild_id) key is dropped, and admin_id gets its own index for "the servers I manage".
ALTER TABLE admin_guild DROP CONSTRAINT admin_guild_pkey;
ALTER TABLE admin_guild ADD CONSTRAINT admin_guild_pkey PRIMARY KEY (guild_id);
CREATE INDEX admin_guild_admin_idx ON admin_guild (admin_id);
