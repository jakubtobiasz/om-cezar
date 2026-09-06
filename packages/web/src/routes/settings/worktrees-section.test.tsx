import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Project settings → Worktrees: the "Keep last N worktrees" field (#483). Renders the
 * current value, saves the entered number (0 = unlimited, sent as a number so it
 * is never mistaken for "clear"), and rejects out-of-range / non-integer input.
 * The API contract itself is pinned server-side in src/server/config-api.test.ts.
 *
 * The field moved out of Resources into its own PROJECT section in step 3.5 (retention sizes
 * one repo's worktree pool). Its store did not move: every save below is a PUT to the
 * project-scoped `/api/v1/config`, which is exactly the half of the split this pins.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(config: Partial<ConfigResponse> = {}) {
  requests = []
  const state: ConfigResponse = {
    baseBranch: null,
    defaultRunner: 'claude',
    systemPrompt: null,
    defaultModels: {},
    modelsLocked: false,
    maxParallel: 2,
    memoryLimitMb: null,
    worktreeRetention: 10,
    liveTitleUpdates: null,
    reviewGate: null,
    worktreeSetup: [],
    worktreeTeardown: [],
    ...config,
  }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/config' && method === 'GET') return json(state)
      if (url === '/api/v1/config' && method === 'PUT') {
        if (body?.worktreeRetention !== undefined) {
          state.worktreeRetention = body.worktreeRetention as number
        }
        for (const key of ['worktreeSetup', 'worktreeTeardown'] as const) {
          if (body?.[key] !== undefined) state[key] = (body[key] ?? []) as string[]
        }
        return json(state)
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** Seeds the step-3.2 route gates — boot id (legacy redirect) + registry (known-check) — so a
 *  flat entry URL lands scoped immediately. The boot project mounts UNSCOPED, so the exact
 *  `/api/v1/*` paths this file's fetch stub matches stay byte-identical. */
function gateSeededClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderAt(entry: string) {
  render(
    <QueryClientProvider client={gateSeededClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const retentionInput = () =>
  document.querySelector<HTMLInputElement>('[data-slot="resources-worktree-retention"]')
const saveButton = () =>
  document.querySelector<HTMLButtonElement>('[data-action="resources-save-retention"]')
const puts = () =>
  requests.filter(
    (r) => r.method === 'PUT' && r.url === '/api/v1/config' && (r.body as { worktreeRetention?: unknown })?.worktreeRetention !== undefined,
  )

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Project settings → Worktrees: keep-last-N-worktrees (#483)', () => {
  it('renders the configured value and disables Save until it changes', async () => {
    serve({ worktreeRetention: 7 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())
    expect(retentionInput()!.value).toBe('7')
    expect(saveButton()!.disabled).toBe(true)
  })

  it('saves the entered count through PUT /api/v1/config', async () => {
    serve({ worktreeRetention: 10 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    fireEvent.change(retentionInput()!, { target: { value: '3' } })
    expect(saveButton()!.disabled).toBe(false)
    fireEvent.click(saveButton()!)

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ worktreeRetention: 3 })
  })

  it('saves 0 as a real value (unlimited), not as a clear', async () => {
    serve({ worktreeRetention: 5 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    fireEvent.change(retentionInput()!, { target: { value: '0' } })
    fireEvent.click(saveButton()!)

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ worktreeRetention: 0 })
  })

  it('rejects a negative, over-limit, or non-integer count (Save stays disabled, no PUT)', async () => {
    serve({ worktreeRetention: 10 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    for (const bad of ['-1', '1001', '2.5', '']) {
      fireEvent.change(retentionInput()!, { target: { value: bad } })
      expect(saveButton()!.disabled).toBe(true)
      expect(document.querySelector('[data-slot="resources-retention-invalid"]')).not.toBeNull()
    }
    expect(puts()).toHaveLength(0)
  })
})

describe('Project settings → Worktrees: setup and teardown commands', () => {
  const area = (slot: string) => document.querySelector<HTMLTextAreaElement>(`[data-slot="${slot}"]`)
  const save = (slot: string) => document.querySelector<HTMLButtonElement>(`[data-action="${slot}-save"]`)

  it('renders the configured commands, one per line, with Save disabled', async () => {
    serve({ worktreeSetup: ['docker compose up -d', 'npm ci'], worktreeTeardown: ['docker compose down -v'] })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(area('worktree-setup')).not.toBeNull())
    expect(area('worktree-setup')!.value).toBe('docker compose up -d\nnpm ci')
    expect(area('worktree-teardown')!.value).toBe('docker compose down -v')
    expect(save('worktree-setup')!.disabled).toBe(true)
  })

  it('saves a list through PUT /api/v1/config, dropping blank lines', async () => {
    serve()
    renderAt('/settings/worktrees')
    await waitFor(() => expect(area('worktree-setup')).not.toBeNull())

    fireEvent.change(area('worktree-setup')!, { target: { value: 'docker compose up -d\n\n  npm ci  \n' } })
    expect(save('worktree-setup')!.disabled).toBe(false)
    fireEvent.click(save('worktree-setup')!)

    await waitFor(() =>
      expect(
        requests.some(
          (r) =>
            r.method === 'PUT' &&
            JSON.stringify((r.body as { worktreeSetup?: unknown })?.worktreeSetup) ===
              JSON.stringify(['docker compose up -d', 'npm ci']),
        ),
      ).toBe(true),
    )
  })

  it('sends [] when the textarea is emptied — the clear path', async () => {
    serve({ worktreeTeardown: ['docker compose down -v'] })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(area('worktree-teardown')).not.toBeNull())

    fireEvent.change(area('worktree-teardown')!, { target: { value: '' } })
    fireEvent.click(save('worktree-teardown')!)

    await waitFor(() =>
      expect(
        requests.some(
          (r) => r.method === 'PUT' && JSON.stringify((r.body as { worktreeTeardown?: unknown })?.worktreeTeardown) === '[]',
        ),
      ).toBe(true),
    )
  })

  it('names the placeholders under each editor', async () => {
    serve()
    renderAt('/settings/worktrees')
    await waitFor(() => expect(area('worktree-setup')).not.toBeNull())
    const text = document.querySelector('[data-slot="worktrees-section"]')!.textContent!
    for (const name of ['repo_path', 'worktree_path', 'run_id', 'branch', 'base_branch']) {
      expect(text).toContain(`{{ ${name} }}`)
    }
    expect(text).toContain('$CEZ_RUN_ID')
  })

  it('blocks Save and explains when a list is past the caps', async () => {
    serve()
    renderAt('/settings/worktrees')
    await waitFor(() => expect(area('worktree-setup')).not.toBeNull())

    fireEvent.change(area('worktree-setup')!, { target: { value: Array.from({ length: 21 }, () => 'true').join('\n') } })
    expect(save('worktree-setup')!.disabled).toBe(true)
    expect(document.querySelector('[data-slot="worktree-setup-invalid"]')?.textContent).toContain('At most 20')

    fireEvent.change(area('worktree-setup')!, { target: { value: 'x'.repeat(2001) } })
    expect(save('worktree-setup')!.disabled).toBe(true)
    expect(document.querySelector('[data-slot="worktree-setup-invalid"]')?.textContent).toContain('2000 characters')
  })
})
