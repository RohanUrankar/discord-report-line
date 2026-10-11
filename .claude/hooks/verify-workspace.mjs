// Stop hook in an agent's frontmatter (runs as SubagentStop): typecheck, lint and test the agent's workspaces
// before it may report "done". Blocks up to MAX_BLOCKS times per agent run, then lets it stop with a warning
// so an unfixable failure can't loop forever — the agent must then report the failure.
// Usage: node verify-workspace.mjs <workspace-dir> [<workspace-dir> ...]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readEvent, block, projectDir } from './lib.mjs';

const MAX_BLOCKS = 3;
const SCRIPTS = ['typecheck', 'lint', 'test'];

const event = await readEvent();
const counterFile = path.join(tmpdir(), `claude-verify-${event.agent_id ?? event.session_id ?? 'default'}.txt`);
const blocksSoFar = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) || 0 : 0;

const failures = [];
for (const dir of process.argv.slice(2)) {
  const pkgPath = path.join(projectDir, dir, 'package.json');
  if (!existsSync(pkgPath)) continue; // workspace not scaffolded yet
  const scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {};
  for (const name of SCRIPTS.filter(s => scripts[s])) {
    const r = spawnSync(`npm run ${name}`, {
      cwd: path.join(projectDir, dir), shell: true, encoding: 'utf8', timeout: 300_000,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }, // CI=true keeps Vitest out of watch mode
    });
    if (r.status !== 0) {
      const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
      failures.push(`### ${dir}: npm run ${name} failed (exit ${r.status ?? 'timeout'})\n${output}`);
    }
  }
}

if (failures.length === 0) {
  writeFileSync(counterFile, '0');
  process.exit(0);
}
if (blocksSoFar >= MAX_BLOCKS) {
  writeFileSync(counterFile, '0');
  process.stderr.write(`verify-workspace: checks still failing after ${MAX_BLOCKS} attempts; allowing stop. The report must list these failures.\n`);
  process.exit(1); // non-blocking notice
}
writeFileSync(counterFile, String(blocksSoFar + 1));
block(`Not done yet — workspace checks failed (attempt ${blocksSoFar + 1}/${MAX_BLOCKS}). Fix these, or if they are outside your step, say so explicitly in your report:\n\n${failures.join('\n\n')}`);
