# Daily Jira Ticket Automation

A local Node.js CLI that fetches your assigned Jira tickets, triages them with a lightweight model, and—when eligible—runs an AI coding agent in isolated Git worktrees. It does not commit, push, open pull requests, or apply database migrations.

## Requirements

- Node.js 20 or later and npm/pnpm
- Jira Cloud API token and an account that can browse assigned issues
- OpenAI-compatible API key or Anthropic API key for triage
- OpenCode CLI on `PATH` by default (or a compatible agent command configured below)
- Local clones of the target repositories

The defaults match the repositories currently present beside this project:

| Jira repo ID | Local directory | Base branch |
| --- | --- | --- |
| `sdk` | `anchor-commerce-sdk` | `main` |
| `dashboard` | `dashboard` | `V3` |
| `api` | `commerce-api` | `V3` |

Override directory names, branches, and roots through the variables in `.env.example`.

## Setup and run

```sh
npm install
cp .env.example .env
# Edit .env with Jira/model credentials and verify the local repository paths.
npm start
```

The Jira query selects issues assigned to the authenticated Jira user in `Accepted into Sprint`, `Development`, or `Dev testing`. Each issue gets a row in `reports/triage-YYYY-MM-DD.csv`, using the machine's local calendar date. Triage is fail-closed; provider errors, ambiguous tickets, tickets with no identified repository, and database-change requirements are marked not solvable.

If an OpenCode or Claude process has a working directory under `HORNBLOWER_ROOT`, coding execution is skipped. The session check is conservative: if process inspection itself fails, coding is also skipped. Set `SESSION_CHECK_ENABLED=false` only if you intentionally want to disable this safeguard.

## Daily 10:00 AM cron

Cron uses the machine's local timezone unless the system/cron environment is configured otherwise. Find the absolute Node path with `which node`, then add a line like this with `crontab -e` (replace the Node path and project path as needed):

```cron
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
0 10 * * * cd /Users/nikhil.jain/Desktop/hornblower/solve-jira-ticket-automation && /absolute/path/to/node src/index.js >> logs/cron.log 2>&1
```

Create the log directory once with `mkdir -p logs`. Cron does not automatically load an interactive shell profile, so keep credentials in the project `.env` file, use an absolute Node path, and set `AGENT_COMMAND` to the absolute `opencode` path (`which opencode`). Protect `.env` as a secret.

**macOS privacy (TCC):** `~/Desktop` is a protected folder. Cron jobs reading it fail with `Operation not permitted` unless `/usr/sbin/cron` is granted Full Disk Access (System Settings → Privacy & Security → Full Disk Access → `+` → ⇧⌘G `/usr/sbin/cron`). Alternatively, move the project and sibling repos out of `~/Desktop`.

A lock file (`reports/.automation.lock`) prevents a cron run and a manual run from overlapping; a lock left by a dead process is replaced automatically.

## Configuration loading

`src/util.js` loads `.env` from the project directory (not the current working directory), so `npm start` works from any directory. Every module imports `util.js`, so environment values are in place before any module reads them at load time.

## Agent configuration

By default, the pipeline invokes `opencode run --standalone --auto [--model MODEL] PROMPT` once per affected repository. `AGENT_COMMAND` changes the executable. `AGENT_ARGS_JSON` optionally supplies a JSON string array of arguments; include `{prompt}` where the ticket prompt should be inserted. No shell is used to invoke the agent. `AGENT_TIMEOUT_MS` controls the per-repository timeout.

### Agent sandbox

- `--auto` approves tool permissions that are not explicitly denied, which a headless run needs to edit files. `--standalone` uses a private server per run instead of the shared background service, so no long-lived `opencode` process stays behind with a working directory under `HORNBLOWER_ROOT` (that would trip the session check on every later run).
- `OPENCODE_CONFIG` points at `config/opencode.automation.json` (override with `AGENT_OPENCODE_CONFIG`). It turns off the `aws-mcp`, `atlassian`, and `datadog` MCP servers from your global config, and blocks commit/push, AWS/IaC CLIs, DB clients, migration/seed/backfill commands, network fetches, and access outside the worktree. Check the merged result with `OPENCODE_CONFIG=config/opencode.automation.json opencode debug config`. If you add new global MCP servers, disable them here too.
- The agent gets an allowlisted environment (PATH, HOME, locale, temp, and XDG dirs). Jira, triage-provider, and AWS credentials are not passed. OpenCode reads its own provider login from `HOME`. If it needs an env key instead, list it in `AGENT_ENV_PASSTHROUGH` (`AWS_*`/`JIRA_*` are always refused).
- Values of credential-like env vars (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`) are redacted from `execution_log.json`.

### Diffs

Each repository's patch is generated against the merge-base of the worktree and `origin/<base branch>`, so the patch still contains any commits the agent made despite instructions. Upstream changes fetched later are not included. `patch-<repo>.diff` can be applied with `git apply`. `patch.diff` combines all repos for reading.

### Re-runs

Tickets stay in `Development` for days, so a ticket whose `solutions/[TICKET-ID]/execution_log.json` already reports `outcome: completed` is skipped (CSV status `skipped: already completed`). Set `FORCE_RERUN=true` to redo it; the existing worktree and branch are reused.

### Worktree conflict recovery

Branch `automation/[TICKET-ID]` is created in the source repo and checked out at `workspaces/[TICKET-ID]/[repo]`:

- A valid worktree already at that path on that branch is reused.
- A non-empty directory at that path that is not a worktree of the source repo, or is on another branch, stops the ticket with a clear error. Nothing is deleted.
- If the branch exists but has no worktree, it is attached at the target path.
- If git still has the target path registered after the directory was deleted, or the branch is held by a missing worktree inside `workspaces/`, the add uses `--force` to reclaim it.
- If the branch is checked out somewhere that still exists, or the registration points to a missing path outside `workspaces/`, the ticket stops with an error naming that path. The automation never runs a repo-wide `git worktree prune`, because that would also remove your own stale registrations.

Triage supports `TRIAGE_PROVIDER=openai` (default) and `TRIAGE_PROVIDER=anthropic`. The OpenAI-compatible route can use `OPENAI_BASE_URL`; Anthropic uses its Messages API. Triage output must identify one or more of `sdk`, `dashboard`, or `api`.

## Outputs and safety

- `reports/triage-YYYY-MM-DD.csv` — daily triage results: `Ticket ID, Ticket URL, Solvable (Yes/No), Reason/Requirements, Execution Status, Run At`. Rows are appended, so a second run on the same day adds rows with a later `Run At`. Cells starting with `= + - @` are prefixed with `'` to block spreadsheet formula injection.
- `workspaces/[TICKET-ID]/[repo]/` — persistent Git worktrees created from the configured `origin` branches.
- `solutions/[TICKET-ID]/patch.diff` — combined tracked and untracked changes; `patch-[repo].diff` per repository.
- `solutions/[TICKET-ID]/execution_log.json` — agent invocation and pipeline steps.
- `solutions/[TICKET-ID]/review_request.md` — Jira-linked review summary.

Worktrees, reports, and solutions are ignored by Git. Existing primary repository checkouts are not switched or reset. The pipeline never stages/commits changes or pushes branches. Database/schema/data migration language is rejected by both model policy and an additional conservative keyword safety check.

### Database-change safety check

After the model answers, `hasDatabaseChangeRequirement` scans the summary, description, acceptance criteria (`JIRA_AC_FIELD`), the most recent `JIRA_COMMENT_LIMIT` comments, labels, and components. A ticket is rejected when the text mentions any of these:

- migration, backfill, or seeding data
- DynamoDB write APIs (`putItem`, `updateItem`, `deleteItem`, `batchWrite*`, `transactWrite*`) or `GSI`/`LSI`
- "data fix", "fix the records/data/balance", "script to update/correct/clean/delete…"
- reindexing
- a data store (database, db, dynamo, sql, schema, s3, bucket, algolia, record) within 100 characters of a change verb, in either order

The check deliberately over-blocks. False positives show in the CSV as `not eligible` with the reason.

### Failure comments

With `JIRA_COMMENT_ON_FAILURE=true`, a failed worktree setup, agent run, or packaging step posts a Jira comment marked internal (`sd.public.comment` → `internal: true`), so on Service Management projects customers never see it. The comment names the step, repository, error, and run time. Local paths are replaced with `<workspace>`/`~` before posting. Triage rejections are recorded in the CSV only, not commented. Always review generated diffs and test them before creating a PR.

Run `npm test` for syntax checks.
