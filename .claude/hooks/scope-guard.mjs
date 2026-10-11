// PreToolUse in an agent's frontmatter: restrict which project paths that agent may write.
// Usage: node scope-guard.mjs <allowed-prefix> [<allowed-prefix> ...]
// Always allowed: docs/ai-journal.md and design proposals (architecture/docs/proposals/NNNN-*.md).
import { readEvent, block, relativeToProject } from './lib.mjs';

const allowed = process.argv.slice(2).map(p => p.replace(/\\/g, '/').replace(/\/$/, ''));
const ALWAYS = [/^docs\/ai-journal\.md$/, /^architecture\/docs\/proposals\/\d{4}-[\w-]+\.md$/];

const event = await readEvent();
const filePath = event.tool_input?.file_path ?? event.tool_input?.notebook_path;
const rel = relativeToProject(filePath);

if (rel === null) block(`Blocked: ${filePath} is outside the project.`);

const norm = s => (process.platform === 'win32' ? s.toLowerCase() : s);
const ok = ALWAYS.some(re => re.test(rel))
  || allowed.some(prefix => norm(rel) === norm(prefix) || norm(rel).startsWith(`${norm(prefix)}/`));

if (!ok) {
  block(`Blocked: ${event.agent_type ?? 'this agent'} may only write to ${allowed.join(', ')} (plus docs/ai-journal.md and architecture/docs/proposals/). `
    + `To change ${rel}, describe the change in your report, or write architecture/docs/proposals/NNNN-<title>.md and stop.`);
}
