import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWorktreeCommand, runWorktreeCommands, worktreeCommandEnv } from './worktree-setup.ts';

/**
 * Per-project worktree setup/teardown commands. The load-bearing promises: ordered
 * execution, a stop at the first failure (so an agent never starts on a half-built
 * worktree), the `CEZ_*` env parallel tasks need to avoid colliding, and a timeout no
 * project command can outlive.
 */

const dirs: string[] = [];

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-setup-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base = { env: {}, timeoutMs: 30_000 };

describe('runWorktreeCommands', () => {
  it('runs commands in order in the given cwd', async () => {
    const cwd = workdir();
    const failure = await runWorktreeCommands({
      ...base,
      cwd,
      commands: ['echo one >> log', 'echo two >> log'],
    });
    expect(failure).toBeNull();
    expect(readFileSync(join(cwd, 'log'), 'utf8')).toBe('one\ntwo\n');
  });

  it('stops at the first non-zero exit and reports it', async () => {
    const cwd = workdir();
    const started: string[] = [];
    const failure = await runWorktreeCommands({
      ...base,
      cwd,
      commands: ['echo before', 'echo boom >&2; exit 3', 'echo after >> never'],
      onStart: (command) => started.push(command),
    });
    expect(failure?.exitCode).toBe(3);
    expect(failure?.command).toBe('echo boom >&2; exit 3');
    expect(failure?.output).toContain('boom');
    expect(started).toHaveLength(2);
    expect(() => readFileSync(join(cwd, 'never'), 'utf8')).toThrow();
  });

  it('reports output as it arrives, not only at exit', async () => {
    const seen: Array<{ at: number; text: string }> = [];
    const startedAt = Date.now();
    const failure = await runWorktreeCommands({
      ...base,
      cwd: workdir(),
      commands: ['echo early; sleep 0.4; echo late'],
      onChunk: (text) => seen.push({ at: Date.now(), text }),
    });
    expect(failure).toBeNull();
    const early = seen.find((c) => c.text.includes('early'));
    expect(early).toBeDefined();
    expect(early!.at - startedAt).toBeLessThan(300);
    expect(seen.some((c) => c.text.includes('late'))).toBe(true);
  });

  it('streams uncapped even though the kept output is capped', async () => {
    let streamed = 0;
    const failure = await runWorktreeCommands({
      ...base,
      cwd: workdir(),
      // One cheap process, not a 5000-iteration shell loop: this asserts volume, and the
      // suite has a load-sensitive neighbour (a hardcoded warm-up wait in
      // server/automations-gate.test.ts) that a CPU-hungry test here tips over.
      commands: ["head -c 40000 /dev/zero | tr '\\0' x"],
      onChunk: (text) => {
        streamed += Buffer.byteLength(text);
      },
    });
    expect(failure).toBeNull();
    // A watching user sees everything; only what is kept and persisted is bounded.
    expect(streamed).toBeGreaterThan(20_000);
  });

  it('an empty list is a no-op', async () => {
    expect(await runWorktreeCommands({ ...base, cwd: workdir(), commands: [] })).toBeNull();
  });

  it('puts the CEZ_* context in the environment', async () => {
    const cwd = workdir();
    const context = {
      runId: 'run-1234',
      worktree: cwd,
      repoRoot: '/repo',
      branch: 'cez/run-1234',
      baseBranch: 'develop',
    };
    const failure = await runWorktreeCommands({
      cwd,
      timeoutMs: 30_000,
      env: worktreeCommandEnv(context),
      commands: ['test "$CEZ_RUN_ID" = run-1234 && test "$CEZ_BRANCH" = cez/run-1234 && test "$CEZ_BASE_BRANCH" = develop && test "$CEZ_REPO_ROOT" = /repo'],
    });
    expect(failure).toBeNull();
  });

  it('reports a spawn-level failure rather than throwing', async () => {
    const failure = await runWorktreeCommands({
      ...base,
      cwd: workdir(),
      commands: ['definitely-not-a-command-1234'],
    });
    expect(failure?.ok).toBe(false);
    expect(failure?.exitCode).not.toBe(0);
  });

  it('kills a command that outlives the timeout and fails it', async () => {
    const failure = await runWorktreeCommands({
      cwd: workdir(),
      env: {},
      timeoutMs: 150,
      commands: ['sleep 30'],
    });
    expect(failure?.ok).toBe(false);
    expect(failure?.output).toContain('timed out');
  });

  it('hands the caller a kill handle so a cancel can interrupt a long command', async () => {
    const failure = await runWorktreeCommands({
      cwd: workdir(),
      env: {},
      timeoutMs: 30_000,
      commands: ['sleep 30'],
      onSpawn: (kill) => setTimeout(kill, 50),
    });
    expect(failure?.ok).toBe(false);
  });
});

describe('renderWorktreeCommand', () => {
  const context = {
    runId: 'run-1234',
    worktree: '/wt/run-1234',
    repoRoot: '/repo',
    branch: 'cez/run-1234',
    baseBranch: 'develop',
  };

  it('expands every placeholder, shell-quoted', () => {
    expect(renderWorktreeCommand('cp {{ repo_path }}/auth.json {{worktree_path}}/', context)).toBe(
      "cp '/repo'/auth.json '/wt/run-1234'/",
    );
    expect(renderWorktreeCommand('echo {{ run_id }} {{ branch }} {{ base_branch }}', context)).toBe(
      "echo 'run-1234' 'cez/run-1234' 'develop'",
    );
  });

  it('quotes a path with spaces into ONE shell word — the reason to prefer it over $CEZ_REPO_ROOT', async () => {
    const spaced = { ...context, repoRoot: "/a b/re'po" };
    const rendered = renderWorktreeCommand('printf %s {{ repo_path }}', spaced);
    const cwd = workdir();
    const marker = join(cwd, 'out');
    const failure = await runWorktreeCommands({
      ...base,
      cwd,
      commands: [`${rendered} > ${marker}`],
    });
    expect(failure).toBeNull();
    expect(readFileSync(marker, 'utf8')).toBe("/a b/re'po");
  });

  it('leaves Go/docker templating alone — {{.Name}} is not ours', () => {
    const command = "docker inspect -f '{{.Name}} {{range .Mounts}}{{.Source}}{{end}}' x";
    expect(renderWorktreeCommand(command, context)).toBe(command);
    expect(renderWorktreeCommand('echo {{ unknown_var }}', context)).toBe('echo {{ unknown_var }}');
  });

  it('runWorktreeCommands renders before spawning when a context is given', async () => {
    const cwd = workdir();
    const seen: string[] = [];
    const failure = await runWorktreeCommands({
      ...base,
      cwd,
      context: { ...context, repoRoot: cwd },
      commands: ['test -d {{ repo_path }}'],
      onStart: (command) => seen.push(command),
    });
    expect(failure).toBeNull();
    // The note shows the EXPANSION, which is what actually ran.
    expect(seen[0]).toBe(`test -d '${cwd}'`);
  });
});
