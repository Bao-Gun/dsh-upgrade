import { describe, expect, test } from 'vitest'
import { runBatch } from '../src/client/batch'
import type { BatchEvent } from '../src/client/batch'
import { OPERATIONS } from '../src/client/market'

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

/** 每次 POST 的包名；POST 顺序就是队列真实发出的顺序。 */
function postName(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body)) as { packageName: string }
  return body.packageName
}

describe('runBatch', () => {
  test('按顺序一个包一个包升，第二个 POST 发生在第一个 succeeded 之后', async () => {
    const posts: string[] = []
    let firstOperationSucceeded = false
    let orderViolated = false
    let sequence = 0

    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') {
        // 第一个包还没轮询到 succeeded 就起第二个，就是并发/乱序。
        if (posts.length > 0 && !firstOperationSucceeded) orderViolated = true
        const name = postName(init)
        posts.push(name)
        sequence += 1
        return jsonResponse({ operation: { operationId: 'op-' + String(sequence) } }, 202)
      }
      if (url === OPERATIONS + '?operationId=op-1') firstOperationSucceeded = true
      return jsonResponse({
        operation: { state: 'succeeded', outcome: { restartRequired: false } },
      })
    })

    const summary = await runBatch(['first', 'second'], fetchImpl, '', { pollIntervalMs: 1 })

    expect(orderViolated).toBe(false)
    expect(posts).toEqual(['first', 'second'])
    expect(summary.succeeded).toEqual(['first', 'second'])
    expect(summary.failed).toEqual([])
    expect(summary.skipped).toEqual([])
    expect(summary.restartRequired).toBe(false)
  })

  test('中间一个包失败后继续升后面的', async () => {
    const posts: string[] = []
    let sequence = 0

    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') {
        const name = postName(init)
        posts.push(name)
        sequence += 1
        return jsonResponse({ operation: { operationId: name + '-' + String(sequence) } }, 202)
      }
      if (url.includes('operationId=b-')) {
        return jsonResponse({
          operation: {
            state: 'failed',
            outcome: { restartRequired: false },
            failure: { code: 'INSTALL_FAILED', message: '磁盘写满' },
          },
        })
      }
      return jsonResponse({
        operation: { state: 'succeeded', outcome: { restartRequired: false } },
      })
    })

    const summary = await runBatch(['a', 'b', 'c'], fetchImpl, '', { pollIntervalMs: 1 })

    expect(summary.failed).toEqual(['b'])
    expect(summary.succeeded).toEqual(['a', 'c'])
    expect(posts).toEqual(['a', 'b', 'c'])
  })

  test('任一成功操作说需要重启就汇总成 restartRequired', async () => {
    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') {
        return jsonResponse({ operation: { operationId: 'op-1' } }, 202)
      }
      expect(url).toBe(OPERATIONS + '?operationId=op-1')
      return jsonResponse({
        operation: { state: 'succeeded', outcome: { restartRequired: true } },
      })
    })

    const summary = await runBatch(['only'], fetchImpl, '', { pollIntervalMs: 1 })

    expect(summary.restartRequired).toBe(true)
    expect(summary.succeeded).toEqual(['only'])
  })

  test('市场不可用时标成 unavailable，不冒充安装失败', async () => {
    const events: BatchEvent[] = []
    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') return jsonResponse({ error: 'boom' }, 500)
      throw new Error('POST 已经失败，不应再轮询：' + url)
    })

    const summary = await runBatch(['x'], fetchImpl, '', {
      pollIntervalMs: 1,
      onEvent: (event) => events.push(event),
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'settled',
      item: {
        name: 'x',
        state: 'failed',
        percent: null,
        detail: null,
        message: '插件更新不可用',
        unavailable: true,
      },
    })
    expect(summary.failed).toEqual(['x'])
  })

  test('排队一直没推进就判卡住，接着升下一个', async () => {
    const posts: string[] = []
    const events: BatchEvent[] = []
    let sequence = 0

    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') {
        const name = postName(init)
        posts.push(name)
        sequence += 1
        return jsonResponse({ operation: { operationId: name + '-' + String(sequence) } }, 202)
      }
      if (url.includes('operationId=stuck-')) {
        return jsonResponse({
          operation: {
            state: 'queued',
            outcome: { restartRequired: false },
            wait: { activeAgentIds: ['s1', 's2'] },
          },
        })
      }
      return jsonResponse({
        operation: { state: 'succeeded', outcome: { restartRequired: false } },
      })
    })

    const summary = await runBatch(['stuck', 'next'], fetchImpl, '', {
      stalledWaitMs: 0,
      pollIntervalMs: 1,
      onEvent: (event) => events.push(event),
    })

    expect(summary.failed).toEqual(['stuck'])
    expect(posts).toEqual(['stuck', 'next'])
    const stuck = events.find(
      (event) => event.kind === 'settled' && event.item.name === 'stuck',
    )
    expect(stuck?.item.state).toBe('failed')
    expect(stuck?.item.message ?? '').toContain('等 2 个运行中的会话结束')
  })

  test('叫停时剩下的包进 skipped，不再发请求', async () => {
    const posts: string[] = []
    let sequence = 0
    let firstSettled = false

    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') {
        posts.push(postName(init))
        sequence += 1
        return jsonResponse({ operation: { operationId: 'op-' + String(sequence) } }, 202)
      }
      return jsonResponse({
        operation: { state: 'succeeded', outcome: { restartRequired: false } },
      })
    })

    const summary = await runBatch(['a', 'b', 'c'], fetchImpl, '', {
      pollIntervalMs: 1,
      cancelled: () => firstSettled,
      onEvent: (event) => {
        if (event.kind === 'settled' && event.item.name === 'a') firstSettled = true
      },
    })

    expect(summary.skipped).toEqual(['b', 'c'])
    expect(summary.succeeded).toEqual(['a'])
    expect(summary.failed).toEqual([])
    expect(posts).toEqual(['a'])
  })

  test('onEvent 抛错不打断整批，两个包都升完', async () => {
    const posts: string[] = []
    const seen: string[] = []
    const polls = new Map<string, number>()
    let sequence = 0
    let eventCalls = 0

    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') {
        const name = postName(init)
        posts.push(name)
        sequence += 1
        polls.set('op-' + String(sequence), 0)
        return jsonResponse({ operation: { operationId: 'op-' + String(sequence) } }, 202)
      }
      const id = new URL(url, 'http://localhost').searchParams.get('operationId') ?? ''
      const count = (polls.get(id) ?? 0) + 1
      polls.set(id, count)
      if (count === 1) {
        return jsonResponse({
          operation: {
            state: 'running',
            outcome: { restartRequired: false },
            progress: { percent: 10, done: 1, total: 10 },
          },
        })
      }
      return jsonResponse({
        operation: { state: 'succeeded', outcome: { restartRequired: false } },
      })
    })

    const summary = await runBatch(['a', 'b'], fetchImpl, '', {
      pollIntervalMs: 1,
      onEvent: (event) => {
        eventCalls += 1
        if (eventCalls === 1) throw new Error('面板炸了')
        seen.push(event.item.name + ':' + event.kind)
      },
    })

    expect(posts).toEqual(['a', 'b'])
    expect(summary.succeeded).toEqual(['a', 'b'])
    expect(summary.failed).toEqual([])
    expect(summary.skipped).toEqual([])
    // 第一条事件被吞掉，后面的照常送到面板。
    expect(seen).toEqual(['a:settled', 'b:running', 'b:settled'])
  })

  test('进度持续变化不算卡住', async () => {
    let polls = 0
    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') return jsonResponse({ operation: { operationId: 'op-1' } }, 202)
      polls += 1
      if (polls === 1) {
        return jsonResponse({
          operation: {
            state: 'running',
            outcome: { restartRequired: false },
            progress: { percent: 25, done: 1, total: 4 },
          },
        })
      }
      if (polls === 2) {
        return jsonResponse({
          operation: {
            state: 'running',
            outcome: { restartRequired: false },
            progress: { percent: 75, done: 3, total: 4 },
          },
        })
      }
      return jsonResponse({
        operation: { state: 'succeeded', outcome: { restartRequired: false } },
      })
    })

    const summary = await runBatch(['pkg'], fetchImpl, '', {
      stalledWaitMs: 0,
      pollIntervalMs: 1,
    })

    expect(polls).toBe(3)
    expect(summary.succeeded).toEqual(['pkg'])
    expect(summary.failed).toEqual([])
  })

  test('回滚文案带原因，没有原因就只说已回滚', async () => {
    const rolledBack = fakeFetch((url, init) => {
      if (init?.method === 'POST') return jsonResponse({ operation: { operationId: 'op-1' } }, 202)
      return jsonResponse({
        operation: {
          state: 'rolled-back',
          outcome: { restartRequired: false },
          failure: { code: 'VERIFY_FAILED', message: '校验失败' },
        },
      })
    })
    const withMessage: BatchEvent[] = []
    const first = await runBatch(['a'], rolledBack.fetchImpl, '', {
      pollIntervalMs: 1,
      onEvent: (event) => withMessage.push(event),
    })

    expect(first.failed).toEqual(['a'])
    expect(withMessage.find((event) => event.kind === 'settled')?.item.message).toBe(
      '已回滚：校验失败',
    )

    const plain = fakeFetch((url, init) => {
      if (init?.method === 'POST') return jsonResponse({ operation: { operationId: 'op-2' } }, 202)
      return jsonResponse({
        operation: { state: 'rolled-back', outcome: { restartRequired: false } },
      })
    })
    const withoutMessage: BatchEvent[] = []
    const second = await runBatch(['b'], plain.fetchImpl, '', {
      pollIntervalMs: 1,
      onEvent: (event) => withoutMessage.push(event),
    })

    expect(second.failed).toEqual(['b'])
    expect(withoutMessage.find((event) => event.kind === 'settled')?.item.message).toBe('已回滚')
  })

  test('宿主已有升级在跑：只报一次，其余包 skipped 不再 POST', async () => {
    const posts: string[] = []
    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') {
        posts.push(postName(init))
        return jsonResponse(
          {
            failure: {
              code: 'OPERATION_BUSY',
              message: 'another public update operation is already running',
              retryable: true,
            },
          },
          409,
        )
      }
      throw new Error('POST 已被拒，不应再轮询：' + url)
    })

    const summary = await runBatch(['a', 'b'], fetchImpl, '', { pollIntervalMs: 1 })

    expect(posts).toEqual(['a'])
    expect(summary.failed).toEqual(['a'])
    expect(summary.skipped).toEqual(['b'])
    expect(summary.succeeded).toEqual([])
  })

  test('running 事件带回真实进度与 detail', async () => {
    const events: BatchEvent[] = []
    let polls = 0
    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') return jsonResponse({ operation: { operationId: 'op-1' } }, 202)
      polls += 1
      if (polls === 1) {
        return jsonResponse({
          operation: {
            state: 'running',
            outcome: { restartRequired: false },
            progress: { percent: 43, detail: '安装依赖' },
          },
        })
      }
      return jsonResponse({
        operation: { state: 'succeeded', outcome: { restartRequired: false } },
      })
    })

    await runBatch(['pkg'], fetchImpl, '', {
      pollIntervalMs: 1,
      onEvent: (event) => events.push(event),
    })

    const running = events.find((event) => event.kind === 'running')
    expect(running?.item).toEqual({
      name: 'pkg',
      state: 'running',
      percent: 43,
      detail: '安装依赖',
      message: null,
      unavailable: false,
    })
    expect(events[events.length - 1]?.item.state).toBe('succeeded')
  })

  test('排队时把等几个会话写在 running 事件里', async () => {
    const events: BatchEvent[] = []
    let polls = 0
    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') return jsonResponse({ operation: { operationId: 'op-1' } }, 202)
      polls += 1
      if (polls === 1) {
        return jsonResponse({
          operation: {
            state: 'queued',
            outcome: { restartRequired: false },
            wait: { activeAgentIds: ['s1', 's2'] },
          },
        })
      }
      return jsonResponse({
        operation: { state: 'succeeded', outcome: { restartRequired: false } },
      })
    })

    await runBatch(['pkg'], fetchImpl, '', {
      pollIntervalMs: 1,
      onEvent: (event) => events.push(event),
    })

    const running = events.find((event) => event.kind === 'running')
    expect(running?.item.message).toBe('等 2 个运行中的会话结束')
  })

  test('names 里的空洞计入 skipped，不静默漏项', async () => {
    const posts: string[] = []
    const { fetchImpl } = fakeFetch((url, init) => {
      if (init?.method === 'POST') {
        const name = postName(init)
        posts.push(name)
        return jsonResponse({ operation: { operationId: name + '-op' } }, 202)
      }
      return jsonResponse({
        operation: { state: 'succeeded', outcome: { restartRequired: false } },
      })
    })
    // 稀疏数组：中间留一个空洞（没有名字）。
    const names: string[] = ['a']
    names[2] = 'b'

    const summary = await runBatch(names, fetchImpl, '', { pollIntervalMs: 1 })

    expect(posts).toEqual(['a', 'b'])
    expect(summary.succeeded).toEqual(['a', 'b'])
    expect(summary.skipped).toEqual([''])
  })
})
