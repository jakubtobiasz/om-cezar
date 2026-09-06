import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * `worktreeSetup` wiring: the project's bring-up commands run in a fresh task
 * worktree, before the first step, and a failure fails the run closed — an agent let
 * loose in a half-built worktree burns a whole run rediscovering that nothing runs.
 * The executor itself is covered in `src/worktree-setup.test.ts`; this pins the seam.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

function fixtureRepo(setup: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-worktree-setup-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  writeFileSync(join(root, '.ai/cezar', 'config.json'), JSON.stringify({ worktreeSetup: setup }), 'utf8');
  return root;
}

async function waitForRun(store: RunStore, id: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (['done', 'failed', 'cancelled'].includes(store.getRun(id)?.status ?? '')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not finish');
}

/** A check-step workflow — no agent CLI needed to prove what ran and in which order. */
function workflow(command: string): WorkflowDef {
  return { name: 'setup-wiring', source: 'built-in', steps: [{ id: 'check', command }] };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('RunManager worktree setup', () => {
  it('runs the configured commands in the worktree before the first step', async () => {
    const root = fixtureRepo(['echo ready > setup-marker', 'echo second >> setup-marker']);
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);

    const record = manager.startRun(workflow('cp setup-marker seen-by-step'), { task: 'task' });
    await waitForRun(store, record.id);

    const run = store.getRun(record.id);
    expect(run?.status).toBe('done');
    // The step saw the setup's output, so setup finished first and in the same cwd.
    expect(readFileSync(join(run!.worktreePath!, 'seen-by-step'), 'utf8')).toBe('ready\nsecond\n');
    const events = store.readEvents(record.id);
    expect(events.some((e) => e.type === 'note' && String(e.message).includes('worktree setup'))).toBe(true);
    // One streaming execute card per command: started + completed persist, the deltas
    // between them are live-only and never reach the file.
    const started = events.filter((e) => e.type === 'item.started');
    const completed = events.filter((e) => e.type === 'item.completed');
    expect(started).toHaveLength(2);
    expect(completed).toHaveLength(2);
    expect(events.some((e) => e.type === 'item.delta')).toBe(false);
    expect(completed[0]!.item).toMatchObject({
      kind: 'tool',
      toolKind: 'execute',
      name: 'worktree-setup',
      status: 'completed',
      exitCode: 0,
    });
  });

  it('streams output live while the command is still running', async () => {
    // Emits, waits, emits again — so a buffered implementation could only deliver both
    // halves at once, after exit. Live deltas must arrive before that.
    const root = fixtureRepo(['echo first; sleep 0.4; echo second']);
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);

    const deltas: Array<{ at: number; text: string }> = [];
    let completedAt = Infinity;
    store.on('event', ({ event }) => {
      if (event.type === 'item.delta' && event.field === 'output') {
        deltas.push({ at: Date.now(), text: String(event.delta) });
      }
      if (event.type === 'item.completed') completedAt = Math.min(completedAt, Date.now());
    });

    const record = manager.startRun(workflow('true'), { task: 'task' });
    await waitForRun(store, record.id);

    // `bash -lc` is a login shell, so the stream can also carry the host's own profile
    // noise on stderr — assert on our markers, not on the exact byte stream.
    const first = deltas.find((d) => d.text.includes('first'));
    const second = deltas.find((d) => d.text.includes('second'));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // The load-bearing part: 'first' reached the wire ~400ms before the command exited,
    // which a buffered implementation could not do.
    expect(first!.at).toBeLessThan(completedAt - 300);
  });

  it('exposes the CEZ_* context to the commands', async () => {
    const root = fixtureRepo(['printf "%s|%s" "$CEZ_RUN_ID" "$CEZ_BRANCH" > env-marker']);
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);

    const record = manager.startRun(workflow('true'), { task: 'task' });
    await waitForRun(store, record.id);

    const run = store.getRun(record.id);
    expect(readFileSync(join(run!.worktreePath!, 'env-marker'), 'utf8')).toBe(`${record.id}|${run!.branch}`);
  });

  it('copies a gitignored file in from the repo root — the documented recipe', async () => {
    const root = fixtureRepo(['cp {{ repo_path }}/auth.json {{ worktree_path }}/']);
    writeFileSync(join(root, 'auth.json'), '{"token":"secret"}', 'utf8');
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);

    const record = manager.startRun(workflow('true'), { task: 'task' });
    await waitForRun(store, record.id);

    const run = store.getRun(record.id);
    expect(run?.status).toBe('done');
    expect(readFileSync(join(run!.worktreePath!, 'auth.json'), 'utf8')).toBe('{"token":"secret"}');
  });

  it('fails the run before any step when a setup command exits non-zero', async () => {
    const root = fixtureRepo(['echo boom >&2; exit 3', 'touch never-reached']);
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);

    const record = manager.startRun(workflow('touch step-ran'), { task: 'task' });
    await waitForRun(store, record.id);

    const run = store.getRun(record.id);
    expect(run?.status).toBe('failed');
    expect(run?.error).toContain('worktree setup failed');
    expect(run?.error).toContain('exit 3');
    expect(existsSync(join(run!.worktreePath!, 'step-ran'))).toBe(false);
    expect(existsSync(join(run!.worktreePath!, 'never-reached'))).toBe(false);
  });

  it('skips setup for a run that opts out of the worktree', async () => {
    const root = fixtureRepo(['touch must-not-run']);
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);

    const record = manager.startRun(workflow('true'), { task: 'task', worktree: false });
    await waitForRun(store, record.id);

    expect(store.getRun(record.id)?.status).toBe('done');
    expect(existsSync(join(root, 'must-not-run'))).toBe(false);
  });
});
