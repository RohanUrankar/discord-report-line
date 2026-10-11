// PreToolUse(Bash|PowerShell): block commands that leak secrets or rewrite history.
import { readEvent, block } from './lib.mjs';

const RULES = [
  [/--no-verify\b/, 'Skipping git hooks (--no-verify) is not allowed — fix what the hook reports instead.'],
  [/\bgit\s+push\b[^|;&]*\s(--force(-with-lease)?|-f)\b/, 'Force-pushing rewrites history the graders will read. Ask the human to do it if truly needed.'],
  [/\bgit\s+add\b[^|;&]*\.env(?!\.(example|sample|template))\b/, 'Never stage .env files. Only .env.example belongs in git.'],
  [/\b(cat|type|less|more|head|tail|bat|Get-Content|gc|Select-String|sls)\b[^|;&]*(^|[\s/\\'"])\.env(\.(?!example|sample|template)\w+)?(\s|'|"|$)/i,
    'Reading .env would copy secrets into the transcript (which may be shared in AI_NOTES). Read .env.example or config/env.ts instead.'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, 'Destructive git command — ask the human first.'],
];

const event = await readEvent();
const command = event.tool_input?.command ?? '';
for (const [re, reason] of RULES) {
  if (re.test(command)) block(`Blocked: ${reason}`);
}
