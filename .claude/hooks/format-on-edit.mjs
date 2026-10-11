// PostToolUse(Write|Edit|MultiEdit): format the touched file with the project's Prettier, if installed. Never blocks.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readEvent, projectDir } from './lib.mjs';

const FORMATTABLE = /\.(ts|tsx|js|mjs|cjs|json|html|scss|css|md|ya?ml)$/i;
const prettier = path.join(projectDir, 'node_modules', 'prettier', 'bin', 'prettier.cjs');

const event = await readEvent();
const filePath = event.tool_input?.file_path;
if (filePath && FORMATTABLE.test(filePath) && existsSync(prettier) && !filePath.includes('node_modules')) {
  spawnSync(process.execPath, [prettier, '--write', '--log-level', 'warn', filePath], { cwd: projectDir, timeout: 20_000, stdio: 'ignore' });
}
