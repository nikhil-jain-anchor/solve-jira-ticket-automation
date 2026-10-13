import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// See README.md — Configuration loading
const CODE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(CODE_ROOT, '.env'), quiet: true });

export const PROJECT_ROOT = path.resolve(process.env.PROJECT_ROOT || CODE_ROOT);
export const HORNBLOWER_ROOT = path.resolve(process.env.HORNBLOWER_ROOT || path.dirname(PROJECT_ROOT));
export const WORKSPACES_DIR = path.join(PROJECT_ROOT, 'workspaces');
export const SOLUTIONS_DIR = path.join(PROJECT_ROOT, 'solutions');
export const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');

export function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;
  return !['false', '0', 'no'].includes(String(value).toLowerCase());
}

export function safeTicketId(ticketId) {
  const value = String(ticketId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) throw new Error(`Unsafe Jira ticket ID: ${value || '(empty)'}`);
  return value;
}

export function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Resolve symlinks for a path that may not exist yet (its parent must). */
export function realPath(target) {
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
}
