// PreToolUse(Write|Edit|MultiEdit|NotebookEdit): block writes to .env files and content that looks like a real secret.
// A line may opt out with the marker "secret-scan:allow" (for deliberately fake fixtures) — use sparingly.
import path from 'node:path';
import { readEvent, block, contentStrings } from './lib.mjs';

const PATTERNS = [
  ['Discord bot token', /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/],
  ['Discord webhook URL', /discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d{15,}\/[\w-]{30,}/],
  ['Slack webhook URL', /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Groq API key', /\bgsk_[A-Za-z0-9]{40,}\b/],
  ['Hosted Postgres URL with password', /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]{8,}@[^\s/]*(?:neon\.tech|supabase\.(?:co|com))/],
  ['Private key block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
];

const event = await readEvent();
const filePath = event.tool_input?.file_path ?? event.tool_input?.notebook_path ?? '';
const base = path.basename(filePath);

if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base)) {
  block(`Blocked: ${base} holds real secrets and is off-limits to agents. Add new variables to .env.example with a placeholder value and to config/env.ts; the human fills in .env.`);
}

for (const text of contentStrings(event.tool_input)) {
  for (const line of text.split('\n')) {
    if (line.includes('secret-scan:allow')) continue;
    for (const [label, re] of PATTERNS) {
      if (re.test(line)) {
        block(`Blocked: this edit to ${filePath || 'a file'} contains what looks like a ${label}. Secrets live only in env vars on the host. Use config (process.env via config/env.ts) or an obviously fake placeholder such as https://example.test/webhook. If the user pasted a real secret into chat, tell them to rotate it.`);
      }
    }
  }
}
