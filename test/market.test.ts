import { describe, expect, test } from 'vitest'
import {
  OPERATIONS,
  SUMMARY,
  UPDATES,
  fetchPluginUpdates,
  pollPluginOperation,
  startPluginUpdate,
} from '../src/client/market'

type FetchCall = { url: string; init?: RequestInit }

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

async function expectUnavailable(fetchImpl: typeof fetch): Promise<void> {
  await expect(fetchPluginUpdates(fetchImpl)).resolves.toEqual({ available: false, updatable: [] })
}

describe('fetchPluginUpdates', () => {
  test('summary 的包映射成 from/to，available 为 true', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({
        schema: 'dsh-market/update-api/v1',
        checked: 12,
        updatable: 1,
        packages: [
          {
            name: 'dsh-better-sidebar',
            source: 'npm',
            installedVersion: '0.32.1',
            latestVersion: '0.32.4',
          },
        ],
      }),
    )

    const result = await fetchPluginUpdates(fetchImpl)

    expect(result).toEqual({
      available: true,
      updatable: [{ name: 'dsh-better-sidebar', from: '0.32.1', to: '0.32.4' }],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(SUMMARY)
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect((calls[0]?.init?.headers as Record<string, string>).Accept).toBe('application/json')
  })

  test('base 前缀拼在常量路径前', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({ schema: 'dsh-market/update-api/v1', checked: 0, updatable: 0, packages: [] }),
    )

    const result = await fetchPluginUpdates(fetchImpl, 'http://127.0.0.1:3080/')

    expect(calls[0]?.url).toBe('http://127.0.0.1:3080' + SUMMARY)
    expect(result).toEqual({ available: true, updatable: [] })
  })

  test('401 登录失败降级为不可用且不抛', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ error: '需要先登录 DSH' }, 401))

    await expectUnavailable(fetchImpl)
  })

  test('500 降级为不可用', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ error: 'boom' }, 500))

    await expectUnavailable(fetchImpl)
  })

  test('JSON 解析失败降级为不可用', async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON')
          },
        }) as unknown as Response,
    )

    await expectUnavailable(fetchImpl)
  })

  test('空响应体降级为不可用', async () => {
    const { fetchImpl } = fakeFetch(() =>
      ({ ok: true, status: 200, json: async () => undefined }) as unknown as Response,
    )

    await expectUnavailable(fetchImpl)
  })

  test('fetch 抛错或拒绝降级为不可用', async () => {
    const throwing = fakeFetch(() => {
      throw new Error('network down')
    })
    const rejecting = fakeFetch(async () => {
      throw new Error('connection refused')
    })

    await expectUnavailable(throwing.fetchImpl)
    await expectUnavailable(rejecting.fetchImpl)
  })

  test('packages 不是数组时降级为不可用', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ schema: 'dsh-market/update-api/v1', packages: { name: 'x' } }),
    )

    await expectUnavailable(fetchImpl)
  })

  test('缺少字段的包跳过，其余条目照常返回', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({
        schema: 'dsh-market/update-api/v1',
        checked: 3,
        updatable: 2,
        packages: [
          { name: 'only-name' },
          { name: 'no-latest', installedVersion: '1.0.0' },
          {
            name: 'dsh-mcp-connector',
            installedVersion: '1.1.0',
            latestVersion: '1.2.0',
          },
        ],
      }),
    )

    const result = await fetchPluginUpdates(fetchImpl)

    expect(result.available).toBe(true)
    expect(result.updatable).toEqual([
      { name: 'dsh-mcp-connector', from: '1.1.0', to: '1.2.0' },
    ])
  })
})

describe('startPluginUpdate', () => {
  test('POST packageName，并从 operation 里取 operationId', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(
        {
          schema: 'dsh-market/update-api/v1',
          operation: { operationId: 'boot-1-update-2', packageName: 'dsh-better-sidebar', state: 'queued' },
        },
        202,
      ),
    )

    await expect(startPluginUpdate('dsh-better-sidebar', fetchImpl)).resolves.toEqual({
      operationId: 'boot-1-update-2',
    })

    expect(calls[0]?.url).toBe(UPDATES)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect((calls[0]?.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ packageName: 'dsh-better-sidebar' })
  })

  test('失败或响应缺 operationId 时返回空 id，不抛', async () => {
    const unauthorized = fakeFetch(() => jsonResponse({ error: '需要先登录 DSH' }, 401))
    const malformed = fakeFetch(() => jsonResponse({ schema: 'dsh-market/update-api/v1' }))
    const rejecting = fakeFetch(async () => {
      throw new Error('network down')
    })

    await expect(startPluginUpdate('dsh-better-sidebar', unauthorized.fetchImpl)).resolves.toEqual({
      operationId: '',
    })
    await expect(startPluginUpdate('dsh-better-sidebar', malformed.fetchImpl)).resolves.toEqual({
      operationId: '',
    })
    await expect(startPluginUpdate('dsh-better-sidebar', rejecting.fetchImpl)).resolves.toEqual({
      operationId: '',
    })
  })
})

describe('pollPluginOperation', () => {
  test('带回 succeeded 与 restartRequired', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({
        schema: 'dsh-market/update-api/v1',
        operation: {
          operationId: 'boot-1-update-2',
          state: 'succeeded',
          outcome: { refreshRequired: false, restartRequired: true },
          failure: null,
          beforeVersion: '0.32.1',
          installedVersion: '0.32.4',
        },
      }),
    )

    await expect(pollPluginOperation('boot-1-update-2', fetchImpl)).resolves.toEqual({
      status: 'succeeded',
      restartRequired: true,
    })
    expect(calls[0]?.url).toBe(OPERATIONS + '?operationId=boot-1-update-2')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
  })

  test('带回 rolled-back 与 restartRequired', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({
        schema: 'dsh-market/update-api/v1',
        operation: {
          operationId: 'boot-1-update-2',
          state: 'rolled-back',
          outcome: { restartRequired: true },
          failure: null,
        },
      }),
    )

    await expect(pollPluginOperation('boot-1-update-2', fetchImpl)).resolves.toEqual({
      status: 'rolled-back',
      restartRequired: true,
    })
  })

  test('failed 时带回 failure.message', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({
        schema: 'dsh-market/update-api/v1',
        operation: {
          operationId: 'boot-1-update-2',
          state: 'failed',
          outcome: { restartRequired: false },
          failure: { code: 'RELEASE_TOO_FRESH', message: '版本太新，暂不可升级', retryable: true },
        },
      }),
    )

    await expect(pollPluginOperation('boot-1-update-2', fetchImpl)).resolves.toEqual({
      status: 'failed',
      restartRequired: false,
      message: '版本太新，暂不可升级',
    })
  })

  test('404、坏响应与 fetch 抛错都收敛为 failed，不抛', async () => {
    const notFound = fakeFetch(() => jsonResponse({ error: 'operation not found' }, 404))
    const malformed = fakeFetch(() => jsonResponse({ schema: 'dsh-market/update-api/v1' }))
    const rejecting = fakeFetch(async () => {
      throw new Error('network down')
    })
    const unavailable = { status: 'failed', restartRequired: false, message: '插件更新不可用' }

    await expect(pollPluginOperation('gone', notFound.fetchImpl)).resolves.toEqual(unavailable)
    await expect(pollPluginOperation('gone', malformed.fetchImpl)).resolves.toEqual(unavailable)
    await expect(pollPluginOperation('gone', rejecting.fetchImpl)).resolves.toEqual(unavailable)
    await expect(pollPluginOperation('', notFound.fetchImpl)).resolves.toEqual(unavailable)
  })
})
