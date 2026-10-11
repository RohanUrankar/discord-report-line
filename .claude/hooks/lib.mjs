// Shared helpers for hook scripts. Hooks receive a JSON event on stdin; exit code 2 blocks and feeds stderr to Claude.
import path from 'node:path';

export async function readEvent() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try { return JSON.parse(raw); } catch { return {}; }
}

export function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

export const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

// Project-relative path with forward slashes, or null if outside the project.
export function relativeToProject(filePath) {
  if (!filePath) return null;
  const rel = path.relative(projectDir, path.resolve(projectDir, filePath)).split(path.sep).join('/');
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

// Every string value inside a tool_input (Write content, Edit new_string, MultiEdit edits[], …), except paths.
export function contentStrings(toolInput) {
  const out = [];
  const walk = (value, key) => {
    if (typeof value === 'string') { if (key !== 'file_path' && key !== 'notebook_path' && key !== 'old_string') out.push(value); }
    else if (Array.isArray(value)) value.forEach(v => walk(v, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  walk(toolInput ?? {}, '');
  return out;
}
