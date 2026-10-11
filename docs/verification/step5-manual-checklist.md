# Step 5 manual check in a real Discord server

Run this once against the deployed (or tunnelled) bot, with the test server's `/status` already working. Replace `<guild>` with the server id. Every query leaves out `interaction_token` and `mirror_webhook_enc`; do not add them. Run them in `psql` against the database the bot uses, newest rows first.

Account A is the one that runs commands. Account B is any other member of the server.

1. **`/report` with no text opens the form.** In Discord: type `/report` and send it with the `text` option left empty. A pop-up titled "Report a problem" appears.

   ```sql
   SELECT count(*) FROM interaction WHERE guild_id = '<guild>' AND created_at > now() - interval '2 minutes';
   ```

   Expect `0`: opening the form stores nothing. Close the pop-up without submitting.

2. **Submit the form.** Run `/report` again, type "the printer is jammed", submit. You see "thinking…", then "Report logged. The team has been notified." with **Acknowledge** and **Escalate** buttons. The Slack channel gets one message.

   ```sql
   SELECT i.type, i.command_name, i.custom_id, i.status, a.type AS action, a.mirror_status,
          j.status AS job, (j.interaction_token IS NULL) AS token_cleared, j.attempts
   FROM interaction i JOIN action a ON a.interaction_id = i.id JOIN job j ON j.interaction_id = i.id
   WHERE i.guild_id = '<guild>' ORDER BY i.created_at DESC LIMIT 1;
   ```

   Expect `5 | report | report_modal | followed_up | report | sent | done | t | 1` (attempts may be higher after a retry). Then `SELECT t.target, t.outcome, t.http_status FROM job_attempt t JOIN job j ON j.id = t.job_id ORDER BY t.started_at DESC LIMIT 2;` shows `followup success` and `mirror success`.

3. **Acknowledge.** Click **Acknowledge** as account A. The message updates in place to "…✅ Acknowledged by @A" and only **Escalate** remains. No new message appears.

   ```sql
   SELECT i.type, i.command_name, i.custom_id, i.status, a.type AS action, a.report_id IS NOT NULL AS linked
   FROM interaction i JOIN action a ON a.interaction_id = i.id
   WHERE i.guild_id = '<guild>' AND i.type = 3 ORDER BY i.created_at DESC LIMIT 1;
   ```

   Expect `3 | (null) | rpt:ack:<report id> | answered | acknowledged | t`.

4. **A second click or another account.** With the default private reply, account B cannot see the buttons, so this cannot happen by hand. To try it: in the dashboard's Command rules, set `/report` to **public** (not private), save, and run a new `/report text:…` as A. Then A and B both click **Acknowledge** at the same moment (count down and click together). One of them gets the message update; the other gets a private note "This report was already acknowledged by @…". A click made after the message has refreshed finds no Acknowledge button at all.

   ```sql
   SELECT a.type, count(*) FROM action a WHERE a.guild_id = '<guild>' AND a.type IN ('acknowledged','escalated') GROUP BY a.type;
   ```

   Expect one `acknowledged` row per report, never two. Any member of the server may click; that is the decision recorded in DESIGN section 5.5, and it is a risk when replies are public.

5. **Escalate.** Click **Escalate**. The message gains "🚨 Escalated by @…" and loses its buttons. Nothing new appears in Slack or the channel: escalating only records the state.

   ```sql
   SELECT a.type, a.report_id IS NOT NULL AS linked, a.mirror_status FROM action a
   WHERE a.guild_id = '<guild>' AND a.type = 'escalated' ORDER BY a.created_at DESC LIMIT 1;
   ```

   Expect `escalated | t | skipped`. The Slack channel still holds one message per report.

6. **A bad rule is refused in the dashboard.** Open Command rules, `/report`, clear the reply message (or paste more than 300 characters) and save. The editor shows a message under the field ("Write a reply of at least one character", or "The reply is N characters. Keep it to 300 or fewer"), puts focus on it, and sends no request. The server's own `400 VALIDATION_FAILED` cannot be reached from this form; it is covered by `guildConfigDb.test.ts`.

   ```sql
   SELECT command_name, enabled, config ->> 'replyMessage' AS reply, updated_at FROM command_rule WHERE guild_id = '<guild>';
   ```

   Expect the row unchanged (same `updated_at` as before the attempt).

   ```sql
   SELECT command_name, enabled, config ->> 'replyMessage' AS reply, updated_at FROM command_rule WHERE guild_id = '<guild>';
   ```

   Expect the row unchanged (same `updated_at` as before the attempt). If the form blocks the save before it reaches the server, the API check is covered by the automated tests.

7. **Turn `/report` off.** In Command rules switch `/report` off and save. Run `/report` (no text): you get "This command is turned off on this server." and no pop-up. Click an old **Escalate** button on any earlier report: same notice.

   ```sql
   SELECT i.command_name, a.type FROM interaction i JOIN action a ON a.interaction_id = i.id
   WHERE i.guild_id = '<guild>' AND a.type = 'disabled' ORDER BY i.created_at DESC LIMIT 1;
   ```

   Expect `report | disabled` for the command attempt. The button click leaves no row. Switch `/report` back on.

8. **A corrupted rule row still works.**

   ```sql
   UPDATE command_rule SET config = '{"version":2,"ephemeral":"yes"}'::jsonb WHERE guild_id = '<guild>' AND command_name = 'report';
   ```

   Run `/report text: still works`. You get "thinking…" then "Report logged. The team has been notified." (the default wording), privately. In the API log there is one warning `rule.invalid_stored` listing field names such as `version` and `ephemeral`, and no values. The dashboard rules page shows `/report` with its defaults.

   ```sql
   SELECT payload ->> 'replyMessage' AS reply, payload ->> 'ephemeral' AS ephemeral
   FROM job j JOIN interaction i ON i.id = j.interaction_id WHERE i.guild_id = '<guild>' ORDER BY i.created_at DESC LIMIT 1;
   ```

   Expect `Report logged. The team has been notified. | true`. Then save the rule again from the dashboard to repair the row.

9. **A rule edited mid-flight does not change that report.** Stop the worker or break the Slack address first (so the job waits), run `/report text: before edit` with the rule private and its wording "A", then change the wording to "B" and make it public, then let the worker run. The reply you get says "A" and is private.

   ```sql
   SELECT payload ->> 'replyMessage' AS reply, payload ->> 'ephemeral' AS ephemeral, status FROM job ORDER BY id DESC LIMIT 1;
   ```

   Expect the wording and privacy as they were when you ran the command.

10. **The dashboard shows it all.** Open the command log for the server. You see `/report` rows (text and form), and "Button: Acknowledge" / "Button: Escalate" rows with status "Answered". Open one: no button id, no token, no report text. Sign in as a second admin who does not manage this server and open the same address: you get "not found".

## What this check cannot prove

- Discord's own client behaviour for a modal that fails server-side validation (the user's text is lost when the notice comes back).
- Two people clicking within the same few milliseconds in a real client; the automated tests drive that with concurrent signed requests.
- Behaviour after the 15-minute token window with real Discord (covered by tests with a stub; needs a patient manual run).
