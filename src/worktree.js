import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { HORNBLOWER_ROOT, WORKSPACES_DIR, isWithin, realPath, safeTicketId } from './util.js';

const REPO_CONFIG = {
  sdk: { path: process.env.SDK_REPO_PATH || 'anchor-commerce-sdk', branch: process.env.SDK_BRANCH || 'main' },
  dashboard: { path: process.env.DASHBOARD_REPO_PATH || 'dashboard', branch: process.env.DASHBOARD_BRANCH || 'V3' },
  api: { path: process.env.API_REPO_PATH || 'commerce-api', branch: process.env.API_BRANCH || 'V3' },
};

/** Parse `git worktree list --porcelain` into [{ path, branch }]. */
async function listWorktrees(sourceGit) {
  const output = await sourceGit.raw(['worktree', 'list', '--porcelain']);
  return output.split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n');
    return {
      path: lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) || '',
      branch: lines.find((line) => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) || '',
    };
  });
}

/**
 * True when worktreePath is already a worktree of sourceRepoPath on expectedBranch.
 * False when it does not exist (or is an empty directory). Throws on any other existing content.
 */
async function isWorktreeAt(worktreePath, expectedBranch, sourceRepoPath) {
  if (!fs.existsSync(worktreePath)) return false;
  if (fs.readdirSync(worktreePath).length === 0) return false;
  const git = simpleGit(worktreePath);
  let root;
  let commonDir;
  let branch;
  try {
    root = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    commonDir = (await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    branch = (await git.raw(['branch', '--show-current'])).trim();
  } catch {
    throw new Error(`Workspace path exists but is not a Git worktree: ${worktreePath}`);
  }
  if (realPath(root) !== realPath(worktreePath) || realPath(commonDir) !== realPath(path.join(sourceRepoPath, '.git'))) {
    throw new Error(`Workspace path exists but is not a worktree of ${sourceRepoPath}: ${worktreePath}`);
  }
  if (branch !== expectedBranch) {
    throw new Error(`Worktree ${worktreePath} is on branch "${branch || '(detached)'}", expected "${expectedBranch}".`);
  }
  return true;
}

/** Create/reuse per-repository worktrees from the configured remote target branches. */
export async function setupWorktrees(ticketId, affectedRepos) {
  const id = safeTicketId(ticketId);
  if (!Array.isArray(affectedRepos) || affectedRepos.length === 0) throw new Error('At least one affected repository is required.');
  const ticketWorkspace = path.join(WORKSPACES_DIR, id);
  fs.mkdirSync(ticketWorkspace, { recursive: true });
  const attachedPaths = {};

  for (const repoName of [...new Set(affectedRepos)]) {
    const config = REPO_CONFIG[repoName];
    if (!config) throw new Error(`Unknown target repository: ${repoName}`);
    const sourceRepoPath = path.resolve(HORNBLOWER_ROOT, config.path);
    if (!fs.existsSync(sourceRepoPath)) throw new Error(`Repository path does not exist for ${repoName}: ${sourceRepoPath}`);
    const sourceGit = simpleGit(sourceRepoPath);
    const sourceRoot = (await sourceGit.raw(['rev-parse', '--show-toplevel'])).trim();
    if (realPath(sourceRoot) !== realPath(sourceRepoPath)) throw new Error(`Configured repository path is not a Git repository root: ${sourceRepoPath}`);

    const branchName = `automation/${id}`;
    const targetWorktreePath = path.join(ticketWorkspace, repoName);
    if (await isWorktreeAt(targetWorktreePath, branchName, sourceRepoPath)) {
      attachedPaths[repoName] = targetWorktreePath;
      continue;
    }

    // Fetch only the configured base branch. Existing developer checkouts are never modified.
    await sourceGit.fetch('origin', config.branch);
    await sourceGit.raw(['rev-parse', '--verify', `refs/remotes/origin/${config.branch}`]);

    // See README.md — Worktree conflict recovery
    const targetPaths = new Set([realPath(targetWorktreePath), path.resolve(targetWorktreePath)]);
    const worktrees = await listWorktrees(sourceGit);
    const staleTarget = worktrees.some((worktree) => targetPaths.has(worktree.path));
    const holder = worktrees.find((worktree) => worktree.branch === branchName);
    if (holder && !targetPaths.has(holder.path)) {
      if (fs.existsSync(holder.path)) {
        throw new Error(`Branch ${branchName} for ${repoName} is already checked out at ${holder.path}. Remove that worktree or move it to ${targetWorktreePath}.`);
      }
      if (!isWithin(realPath(WORKSPACES_DIR), holder.path)) {
        throw new Error(`Branch ${branchName} for ${repoName} is registered to a missing worktree outside workspaces/ (${holder.path}). Run "git worktree prune" in ${sourceRepoPath} after checking it.`);
      }
    }
    const force = (staleTarget || holder) ? ['--force'] : [];
    const branchExists = Boolean((await sourceGit.raw(['branch', '--list', branchName])).trim());
    const args = branchExists
      ? ['worktree', 'add', ...force, targetWorktreePath, branchName]
      : ['worktree', 'add', ...force, '-b', branchName, targetWorktreePath, `origin/${config.branch}`];
    try {
      await sourceGit.raw(args);
    } catch (error) {
      throw new Error(`Could not ${branchExists ? 'attach existing branch' : 'create worktree'} for ${repoName}: ${error.message}`);
    }
    attachedPaths[repoName] = targetWorktreePath;
  }
  return attachedPaths;
}

export { REPO_CONFIG };
