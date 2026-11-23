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

const UNAVAILABLE_OPERATION = {
  status: 'failed',
  restartRequired: false,
  code: 'MARKET_UNAVAILABLE',
  message: '插件更新不可用',
  retryable: true,
} as const

describe('fetchPluginUpdates', () => {
  test('summary 的包映射成 from/to，available 与 checked 一并带回', async () => {
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
      checked: 12,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(SUMMARY)
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect((calls[0]?.init?.headers as Record<string, string>).Accept).toBe('application/json')
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

  test('fetch 同步抛错或异步拒绝都降级为不可用', async () => {
    const throwing = (() => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const rejecting = fakeFetch(async () => {
      throw new Error('connection refused')
    })

    await expectUnavailable(throwing)
    await expectUnavailable(rejecting.fetchImpl)
  })

  test('packages 不是数组时降级为不可用', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ schema: 'dsh-market/update-api/v1', packages: { name: 'x' } }),
    )

    await expectUnavailable(fetchImpl)
  })

  test('缺少字段的包跳过，其余条目与 checked 照常返回', async () => {
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

    expect(result).toEqual({
      available: true,
      updatable: [{ name: 'dsh-mcp-connector', from: '1.1.0', to: '1.2.0' }],
      checked: 3,
    })
  })

  test('checked 缺失时不补字段', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ schema: 'dsh-market/update-api/v1', packages: [] }),
    )

    await expect(fetchPluginUpdates(fetchImpl)).resolves.toEqual({ available: true, updatable: [] })
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

  test('409 保留宿主给出的 OPERATION_BUSY 与 message', async () => {
    const busyMessage = 'another public update operation is already running'
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(
        {
          schema: 'dsh-market/update-api/v1',
          error: busyMessage,
          failure: { code: 'OPERATION_BUSY', message: busyMessage, retryable: true },
        },
        409,
      ),
    )

    await expect(startPluginUpdate('dsh-better-sidebar', fetchImpl)).resolves.toEqual({
      operationId: '',
      code: 'OPERATION_BUSY',
      message: busyMessage,
    })
  })

  test('401 保留 MARKET_UNAUTHORIZED 与登录提示', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ error: '需要先登录 DSH' }, 401))

    await expect(startPluginUpdate('dsh-better-sidebar', fetchImpl)).resolves.toEqual({
      operationId: '',
      code: 'MARKET_UNAUTHORIZED',
      message: '需要先登录 DSH',
    })
  })

  test('坏响应与 fetch 拒绝时给出 MARKET_UNAVAILABLE，不抛', async () => {
    const malformed = fakeFetch(() => jsonResponse({ schema: 'dsh-market/update-api/v1' }))
    const rejecting = fakeFetch(async () => {
      throw new Error('network down')
    })
    const unavailable = {
      operationId: '',
      code: 'MARKET_UNAVAILABLE',
      message: '插件更新不可用',
    }

    await expect(startPluginUpdate('dsh-better-sidebar', malformed.fetchImpl)).resolves.toEqual(unavailable)
    await expect(startPluginUpdate('dsh-better-sidebar', rejecting.fetchImpl)).resolves.toEqual(unavailable)
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

  test('真实 failed 带回 failure 的 code / message / retryable', async () => {
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
      code: 'RELEASE_TOO_FRESH',
      message: '版本太新，暂不可升级',
      retryable: true,
    })
  })

  test('failed 但没有 failure 时补 UPDATE_FAILED，不冒充请求失败', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({
        schema: 'dsh-market/update-api/v1',
        operation: {
          operationId: 'boot-1-update-2',
          state: 'failed',
          outcome: { restartRequired: false },
          failure: null,
        },
      }),
    )

    await expect(pollPluginOperation('boot-1-update-2', fetchImpl)).resolves.toEqual({
      status: 'failed',
      restartRequired: false,
      code: 'UPDATE_FAILED',
      retryable: false,
    })
  })

  test('404 是记录失效（OPERATION_UNKNOWN），不是安装失败', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ error: 'operation not found' }, 404))

    await expect(pollPluginOperation('boot-1-update-2', fetchImpl)).resolves.toEqual({
      status: 'failed',
      restartRequired: false,
      code: 'OPERATION_UNKNOWN',
      message: '升级记录已失效，宿主可能已重启',
      retryable: false,
    })
  })

  test('401 是登录失效（MARKET_UNAUTHORIZED），不是安装失败', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ error: '需要先登录 DSH' }, 401))

    await expect(pollPluginOperation('boot-1-update-2', fetchImpl)).resolves.toEqual({
      status: 'failed',
      restartRequired: false,
      code: 'MARKET_UNAUTHORIZED',
      message: '需要先登录 DSH',
      retryable: false,
    })
  })

  test('5xx、坏响应、fetch 拒绝都收敛为 MARKET_UNAVAILABLE', async () => {
    const serverError = fakeFetch(() => jsonResponse({ error: 'boom' }, 500))
    const malformed = fakeFetch(() => jsonResponse({ schema: 'dsh-market/update-api/v1' }))
    const rejecting = fakeFetch(async () => {
      throw new Error('network down')
    })

    await expect(pollPluginOperation('boot-1-update-2', serverError.fetchImpl)).resolves.toEqual(
      UNAVAILABLE_OPERATION,
    )
    await expect(pollPluginOperation('boot-1-update-2', malformed.fetchImpl)).resolves.toEqual(
      UNAVAILABLE_OPERATION,
    )
    await expect(pollPluginOperation('boot-1-update-2', rejecting.fetchImpl)).resolves.toEqual(
      UNAVAILABLE_OPERATION,
    )
  })

  test('空 operationId 直接返回 OPERATION_UNKNOWN，不发请求', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({}))

    await expect(pollPluginOperation('', fetchImpl)).resolves.toEqual({
      status: 'failed',
      restartRequired: false,
      code: 'OPERATION_UNKNOWN',
      message: '升级记录已失效，宿主可能已重启',
      retryable: false,
    })
    expect(calls).toHaveLength(0)
  })
})

describe('base', () => {
  test('三个请求都拼同一个 base，且只去一次尾部斜杠', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.endsWith(SUMMARY)) return jsonResponse({ packages: [] })
      if (url.endsWith(UPDATES)) {
        return jsonResponse({ operation: { operationId: 'op-1' } }, 202)
      }
      return jsonResponse({
        operation: { state: 'running', outcome: { restartRequired: false }, failure: null },
      })
    })
    const base = 'http://127.0.0.1:3080/'

    await fetchPluginUpdates(fetchImpl, base)
    await startPluginUpdate('dsh-better-sidebar', fetchImpl, base)
    await pollPluginOperation('op-1', fetchImpl, base)

    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:3080' + SUMMARY,
      'http://127.0.0.1:3080' + UPDATES,
      'http://127.0.0.1:3080' + OPERATIONS + '?operationId=op-1',
    ])
  })
})
