import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HORNBLOWER_ROOT, PROJECT_ROOT, REPORTS_DIR, SOLUTIONS_DIR, envFlag, isWithin, safeTicketId } from './util.js';
import { fetchActiveTickets, postJiraComment } from './jira.js';
import { appendTriageResult, evaluateTicket } from './triage.js';
import { setupWorktrees } from './worktree.js';
import { runAgentPipeline } from './executor.js';

const SESSION_CHECK_ENABLED = envFlag('SESSION_CHECK_ENABLED', true);
const LOCK_PATH = path.join(REPORTS_DIR, '.automation.lock');

/** Find Claude/OpenCode processes whose working directory is inside the project root. */
function findActiveCodingSessions(rootPath) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return [];
  let processRows;
  try {
    processRows = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 }).split('\n');
  } catch (error) {
    console.warn(`Session inspection failed; agent execution will be skipped for safety: ${error.message}`);
    return [{ name: 'session inspection unavailable', pid: null }];
  }

  const sessions = [];
  for (const row of processRows) {
    const match = row.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) === process.pid) continue;
    const [, pid, command] = match;
    if (!/(?:^|[\/\s])(opencode|claude)(?:\s|$|\/)|Claude\.app/i.test(command)) continue;

    let cwd = '';
    try {
      const output = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {
        encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
      });
      cwd = output.split('\n').find((line) => line.startsWith('n'))?.slice(1) || '';
    } catch {
      // Some process owners cannot be inspected. A command line naming this root is still actionable.
    }
    if ((cwd && isWithin(rootPath, path.resolve(cwd))) || command.includes(rootPath)) {
      sessions.push({ name: /opencode/i.test(command) ? 'OpenCode' : 'Claude', pid: Number(pid), cwd: cwd || null });
    }
  }
  return sessions;
}

function log(level, message, metadata = {}) {
  const record = { timestamp: new Date().toISOString(), level, message, ...metadata };
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[method](JSON.stringify(record));
}

/** Single-run lock so cron and a manual run never overlap. Stale locks (dead pid) are replaced. */
function acquireLock() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim());
    try {
      if (pid) { process.kill(pid, 0); return false; }
    } catch {
      // Holder is gone; take over the lock.
    }
    fs.writeFileSync(LOCK_PATH, String(process.pid));
    return true;
  }
}

function releaseLock() {
  try {
    if (fs.readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_PATH);
  } catch {
    // Already removed.
  }
}

function alreadyCompleted(ticketKey) {
  try {
    const logFile = path.join(SOLUTIONS_DIR, safeTicketId(ticketKey), 'execution_log.json');
    return JSON.parse(fs.readFileSync(logFile, 'utf8')).outcome === 'completed';
  } catch {
    return false;
  }
}

/** Remove local filesystem paths before text leaves the machine. */
function sanitizeForJira(text) {
  return String(text ?? '')
    .split(HORNBLOWER_ROOT).join('<workspace>')
    .split(os.homedir()).join('~');
}

function failureComment(ticket, error) {
  return [
    'Automated ticket pipeline failed (internal note).',
    `Step: ${error.step || 'unknown'}`,
    error.repo ? `Repository: ${error.repo}` : '',
    `Error: ${sanitizeForJira(error.message)}`,
    `Run: ${new Date().toISOString()}`,
    'Artifacts and the full execution log are on the automation host under solutions/. No commit, push, or database change was made.',
  ].filter(Boolean).join('\n');
}

/** Returns the execution status recorded in the CSV. */
async function processTicket(ticket, sessionBlockers) {
  let decision;
  try {
    decision = await evaluateTicket(ticket);
  } catch (error) {
    decision = {
      solvable: false,
      requiresDbMigration: false,
      affectedRepos: [],
      reason: `Triage failed closed: ${error.message}`,
      requirements: [],
    };
  }
  const record = (status) => { appendTriageResult(ticket, decision, status); return status; };

  if (!decision.solvable || decision.requiresDbMigration) {
    log('info', 'Ticket not eligible for automated implementation', { ticket: ticket.key, reason: decision.reason });
    return record('not eligible');
  }
  if (!envFlag('FORCE_RERUN') && alreadyCompleted(ticket.key)) {
    log('info', 'Skipping ticket with a completed solution package (set FORCE_RERUN=true to redo)', { ticket: ticket.key });
    return record('skipped: already completed');
  }
  if (sessionBlockers.length > 0) {
    log('warn', 'Skipping coding pipeline because an active local coding session was detected', {
      ticket: ticket.key, sessions: sessionBlockers,
    });
    return record('skipped: active coding session');
  }
  if (decision.affectedRepos.length === 0) {
    log('warn', 'Skipping ticket because triage did not identify a target repository', { ticket: ticket.key });
    return record('skipped: no target repository');
  }

  let workspacePaths = {};
  try {
    try {
      workspacePaths = await setupWorktrees(ticket.key, decision.affectedRepos);
      if (Object.keys(workspacePaths).length === 0) throw new Error('No valid worktrees were created. Check the repository configuration.');
    } catch (error) {
      error.step = error.step || 'worktree setup';
      throw error;
    }
    const solutionPath = await runAgentPipeline(ticket, decision, workspacePaths, { projectRoot: PROJECT_ROOT });
    log('info', 'Solution package generated', { ticket: ticket.key, solutionPath });
    return record('executed');
  } catch (error) {
    log('error', 'Ticket coding pipeline failed', { ticket: ticket.key, step: error.step, error: error.message });
    if (envFlag('JIRA_COMMENT_ON_FAILURE')) {
      try {
        await postJiraComment(ticket.key, failureComment(ticket, error));
      } catch (commentError) {
        log('error', 'Could not post Jira failure comment', { ticket: ticket.key, error: commentError.message });
      }
    }
    return record(`failed: ${error.step || 'unknown'}`);
  }
}

export async function runDailyAutomation() {
  if (!acquireLock()) {
    log('warn', 'Another automation run is in progress; exiting', { lock: LOCK_PATH });
    return;
  }
  try {
    log('info', 'Daily Jira automation started', { projectRoot: PROJECT_ROOT, hornblowerRoot: HORNBLOWER_ROOT });
    let blockers = [];
    if (SESSION_CHECK_ENABLED) {
      blockers = findActiveCodingSessions(HORNBLOWER_ROOT);
      log(blockers.length ? 'warn' : 'info', blockers.length ? 'Local coding session detected' : 'No local coding sessions detected', {
        sessions: blockers,
      });
    }

    const tickets = await fetchActiveTickets();
    log('info', 'Fetched active Jira tickets', { count: tickets.length });
    for (const ticket of tickets) await processTicket(ticket, blockers);
    log('info', 'Daily Jira automation completed', { processed: tickets.length });
  } finally {
    releaseLock();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runDailyAutomation().catch((error) => {
    log('error', 'Daily Jira automation stopped', { error: error.message });
    process.exitCode = 1;
  });
}
