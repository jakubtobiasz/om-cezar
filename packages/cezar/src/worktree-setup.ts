import { spawn } from 'node:child_process';
import { WORKTREE_TEMPLATE_VARS } from '@open-mercato/cezar-contract';
import { shellQuote } from './core/shell-env.ts';

/**
 * Per-project worktree setup/teardown commands (`.ai/cezar/config.json`). A task
 * worktree is a bare checkout, so `worktreeSetup` runs the project's bring-up after
 * `createWorktree` and before the first agent step; `worktreeTeardown` is the mirror,
 * run from `removeWorktree`.
 *
 * A second shell executor rather than a refactor of `RunManager.runCheckStep`: that one
 * is wired to `ActiveRun.interrupt` and per-step ids, teardown runs where no
 * `RunManager` exists, and this needs a per-command timeout so a hung
 * `docker compose up` can never wedge the run queue or retention.
 */

/** Tool-item `name` for a setup command's card. The headless CLI keys on it to print
 *  setup output, which it would otherwise miss — it renders v1 events only. */
export const WORKTREE_SETUP_ITEM_NAME = 'worktree-setup';

/** Output cap per command — the value check steps use (`workflows/run.ts`). */
const OUTPUT_CAP = 20_000;

/** Setup runs before the agent; installs and image pulls are legitimately slow. */
export const SETUP_TIMEOUT_MS = 10 * 60_000;

/** Teardown blocks a worktree removal, so it gets a much shorter leash. */
export const TEARDOWN_TIMEOUT_MS = 2 * 60_000;

export interface WorktreeCommandResult {
  ok: boolean;
  command: string;
  /** Process exit code; -1 for a spawn failure or a timeout kill. */
  exitCode: number;
  /** Combined stdout+stderr, capped at `OUTPUT_CAP`. Never empty. */
  output: string;
}

/** The `CEZ_*` block every command gets on top of `process.env`. */
export interface WorktreeCommandContext {
  runId: string;
  /** Absolute worktree path — also the cwd the commands run in. */
  worktree: string;
  /** The project root the worktree forked from. */
  repoRoot: string;
  branch: string;
  baseBranch: string;
}

/** `COMPOSE_PROJECT_NAME=cez-$CEZ_RUN_ID` is why the run id has to be reachable from the
 *  command line: it is what keeps concurrent tasks off each other's names and ports. */
export function worktreeCommandEnv(context: WorktreeCommandContext): Record<string, string> {
  return {
    CEZ_RUN_ID: context.runId,
    CEZ_WORKTREE: context.worktree,
    CEZ_REPO_ROOT: context.repoRoot,
    CEZ_BRANCH: context.branch,
    CEZ_BASE_BRANCH: context.baseBranch,
  };
}

/** `{{ name }}` for the whitelisted names only — see `WORKTREE_TEMPLATE_VARS`. */
const TEMPLATE_RE = new RegExp(`\\{\\{\\s*(${WORKTREE_TEMPLATE_VARS.join('|')})\\s*\\}\\}`, 'g');

/**
 * Expand `{{ repo_path }}` and friends, SHELL-QUOTED.
 *
 * Quoting is the whole point: it is what lets a command be written without quotes of its
 * own (`cp {{ repo_path }}/auth.json .`) and still survive a path containing a space —
 * the trap in the bare-env spelling `cp $CEZ_REPO_ROOT/auth.json .`, which silently
 * splits into two arguments. `'/a b/repo'/auth.json` is one word to the shell.
 *
 * Only whitelisted names are touched. Everything else in `{{ }}` passes through verbatim,
 * because Go templating shares the syntax and `docker inspect -f '{{.Name}}'` is exactly
 * the kind of command that belongs in a teardown list.
 */
export function renderWorktreeCommand(command: string, context: WorktreeCommandContext): string {
  const values: Record<string, string> = {
    repo_path: context.repoRoot,
    worktree_path: context.worktree,
    run_id: context.runId,
    branch: context.branch,
    base_branch: context.baseBranch,
  };
  return command.replace(TEMPLATE_RE, (_match, name: string) => shellQuote(values[name] ?? ''));
}

function runOne(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  onSpawn?: (kill: () => void) => void,
  onChunk?: (chunk: string) => void,
): Promise<WorktreeCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: { ...process.env, ...env },
    });
    onSpawn?.(() => child.kill('SIGTERM'));

    let output = '';
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // Live first, and UNCAPPED: the cap bounds what is kept and persisted, not what a
      // watching user sees. `npm ci` is minutes of silence otherwise.
      onChunk?.(text);
      if (output.length < OUTPUT_CAP) {
        output += text;
        if (output.length >= OUTPUT_CAP) output += '\n… (output truncated)';
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    let settled = false;
    const settle = (result: WorktreeCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (err) => {
      settle({ ok: false, command, exitCode: -1, output: `failed to spawn: ${err.message}` });
    });
    child.on('close', (code) => {
      const trimmed = output.trim() || '(no output)';
      if (timedOut) {
        settle({
          ok: false,
          command,
          exitCode: -1,
          output: `${trimmed}\n… timed out after ${Math.round(timeoutMs / 1000)}s — terminated`,
        });
        return;
      }
      settle({ ok: code === 0, command, exitCode: code ?? -1, output: trimmed });
    });
  });
}

/**
 * Run `commands` in order in `cwd`, stopping at the first non-zero exit. Returns the
 * failing result, or `null` when everything passed (an empty list included). Never
 * throws — a spawn failure and a timeout are ordinary failures, and what a failure
 * MEANS is the caller's: setup fails the run closed, teardown stays best-effort.
 */
export async function runWorktreeCommands(opts: {
  commands: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Placeholder values. Omit to run the commands verbatim (`{{ }}` untouched). */
  context?: WorktreeCommandContext;
  onStart?: (command: string) => void;
  /** Output as it arrives, for live streaming. Uncapped — see `collect`. */
  onChunk?: (chunk: string) => void;
  onResult?: (result: WorktreeCommandResult) => void;
  onSpawn?: (kill: () => void) => void;
}): Promise<WorktreeCommandResult | null> {
  for (const raw of opts.commands) {
    const command = opts.context ? renderWorktreeCommand(raw, opts.context) : raw;
    // Report the RENDERED command: it is what actually ran, and seeing the expansion is
    // how a user debugs a setup line that copied from somewhere unexpected.
    opts.onStart?.(command);
    const result = await runOne(command, opts.cwd, opts.env, opts.timeoutMs, opts.onSpawn, opts.onChunk);
    opts.onResult?.(result);
    if (!result.ok) return result;
  }
  return null;
}
