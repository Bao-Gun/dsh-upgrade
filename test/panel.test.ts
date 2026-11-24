// @vitest-environment jsdom
/**
 * 面板与客户端入口。
 *
 * 全程用假 fetch：断言面板打出去的方法 / 路径 / 头 / 体，以及每种降级路径
 * 画出来的中文。升级进度既测流式 body，也测 jsdom 里 fetch 没有 body 时
 * 退回 text() 的路径——后者是测试环境最容易漏掉的一条。
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { closePanel, openPanel, paintBatchItem, probeHasUpdate, type PluginRowView } from '../src/client/panel'
import { apply } from '../src/client/index'

type Call = { url: string, method: string, headers: Record<string, string>, body: unknown }
type FakeInit = { method?: string, headers?: Record<string, string>, body?: string | null }
type FakeResponse = {
  ok: boolean
  status: number
  body: unknown
  json(): Promise<unknown>
  text(): Promise<string>
}

/** 只回答 pathname，apiBase（origin）不参与匹配。 */
function pathOf(url: string): string {
  return new URL(url, 'http://localhost').pathname
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function textResponse(text: string, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  }
}

/** 真流式 body：走 getReader 分支。 */
function streamResponse(chunks: string[], status = 200): FakeResponse {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return {
    ok: status >= 200 && status < 300,
    status,
    body: stream,
    json: async () => null,
    text: async () => chunks.join(''),
  }
}

/** 手动推的流：用来在流没结束时断言进度条上的中间状态。 */
function controlledStream(): { response: FakeResponse, push: (text: string) => void, close: () => void } {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const chunks: string[] = []
  const stream = new ReadableStream<Uint8Array>({
    start(inner) {
      controller = inner
    },
  })
  const response: FakeResponse = {
    ok: true,
    status: 200,
    body: stream,
    json: async () => null,
    text: async () => chunks.join(''),
  }
  return {
    response,
    push(text: string) {
      chunks.push(text)
      controller?.enqueue(encoder.encode(text))
    },
    close() {
      controller?.close()
    },
  }
}

/** routes 的键是 "METHOD /path"。没命中的路由回 404；处理器第二个参数是原始 url。 */
type RouteHandler = (init: FakeInit, url: string) => FakeResponse | Promise<FakeResponse>

function serve(routes: Record<string, RouteHandler>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: unknown, init: FakeInit = {}) => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(init.headers ?? {})) headers[key.toLowerCase()] = value
    calls.push({ url, method, headers, body: init.body === undefined || init.body === null ? undefined : JSON.parse(init.body) })
    const route = routes[method + ' ' + pathOf(url)]
    if (route === undefined) return jsonResponse({ code: 'NOT_FOUND', message: '没有这个路由' }, 404) as unknown as Response
    return route(init, url) as unknown as Response
  })
  return calls
}

/** 一个操作在某一轮轮询里的样子；数组的末项会被重复返回，直到测试中途 push 新项。 */
type OperationStep = {
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'rolled-back'
  percent?: number
  wait?: { code?: string, message?: string, activeAgentIds?: string[] }
  failure?: { code?: string, message?: string }
  restartRequired?: boolean
}

type BatchRoutesOptions = {
  /** summary 里按这个顺序给可更新的包。 */
  packages?: string[]
  /** 每个包自己的轮询剧本；不写就是「先 running 一次，再一次 succeeded」。 */
  steps?: Record<string, OperationStep[]>
  /** POST 直接以这个状态码失败（模拟请求层不可用）。 */
  postStatus?: number
  /** 只让指定包的 POST 失败，其余照常起操作。 */
  postFailures?: Record<string, { status: number, code?: string, message?: string }>
  onPost?: (name: string) => void
  onPoll?: (name: string, index: number) => void
}

/**
 * 市场三端点的桩：POST 立刻 202 给 operationId，GET operations 按每个包自己的
 * 剧本逐个返回，summary 给出给定包。steps 的数组可以在测试中途 push，用来放行
 * 一直 running 的包。
 */
function batchRoutes(options: BatchRoutesOptions = {}): Record<string, RouteHandler> {
  const names = options.packages ?? ['a', 'b']
  const steps = options.steps ?? {}
  const polls: Record<string, number> = {}
  return {
    'GET /dsh-upgrade/api/status': () => jsonResponse(SURVEY_UPDATE),
    'GET /dsh-upgrade/api/releases': () => jsonResponse(RELEASES),
    'GET /dsh-market/api/v1/updates/summary': () =>
      jsonResponse({
        schema: 1,
        checked: names.length,
        packages: names.map((name) => ({
          name,
          source: 'npm',
          installedVersion: '1.0.0',
          latestVersion: '1.1.0',
        })),
      }),
    'POST /dsh-market/api/v1/updates': (init) => {
      const body = init.body === undefined || init.body === null ? null : (JSON.parse(init.body) as { packageName?: string })
      const name = body?.packageName ?? ''
      options.onPost?.(name)
      if (options.postStatus !== undefined) {
        return jsonResponse({ code: 'MARKET_UNAVAILABLE', message: '插件更新不可用' }, options.postStatus)
      }
      const failure = options.postFailures?.[name]
      if (failure !== undefined) {
        return jsonResponse(
          { failure: { code: failure.code ?? 'INSTALL_FAILED', message: failure.message ?? '' } },
          failure.status,
        )
      }
      return jsonResponse({ operation: { operationId: 'op-' + name } }, 202)
    },
    'GET /dsh-market/api/v1/operations': (_init, url) => {
      const operationId = new URL(url, 'http://localhost').searchParams.get('operationId') ?? ''
      const name = operationId.startsWith('op-') ? operationId.slice(3) : ''
      const index = polls[name] ?? 0
      polls[name] = index + 1
      options.onPoll?.(name, index)
      const list = steps[name] ?? [{ state: 'running' }, { state: 'succeeded' }]
      const fallback: OperationStep = { state: 'succeeded' }
      const step = list[Math.min(index, Math.max(list.length - 1, 0))] ?? fallback
      return jsonResponse({
        operation: {
          operationId,
          state: step.state,
          outcome: { restartRequired: step.restartRequired === true },
          ...(step.percent !== undefined ? { progress: { percent: step.percent } } : {}),
          ...(step.wait !== undefined ? { wait: step.wait } : {}),
          ...(step.failure !== undefined ? { failure: step.failure } : {}),
        },
      })
    },
  }
}

function callsTo(calls: Call[], method: string, path: string): Call[] {
  return calls.filter((call) => call.method === method && pathOf(call.url) === path)
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 确认重启有 800ms 冷却；正常意图要隔开两次点击。 */
async function confirmRestart(button: HTMLButtonElement | null): Promise<void> {
  if (button === null) return
  button.click()
  await new Promise((resolve) => setTimeout(resolve, 810))
  button.click()
}

const SURVEY_UPDATE = {
  current: '0.2.2-rc.5',
  channels: { latest: '0.2.2-rc.5', next: null, alpha: '0.2.3-alpha.2' },
  target: '0.2.3-alpha.2',
  blocked: null,
  includePrerelease: false,
}

const RELEASES = {
  releases: [
    {
      version: '0.2.3-alpha.2',
      channel: 'alpha',
      publishedAt: '2026-11-20T10:00:00Z',
      items: ['新增升级面板', '修复重启后角标不刷新'],
      url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.3-alpha.2',
    },
    {
      version: '0.2.3-alpha.1',
      channel: 'alpha',
      publishedAt: '2026-11-18T10:00:00Z',
      items: ['预发布通道'],
      url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.3-alpha.1',
    },
  ],
  degraded: false,
}

const MARKET = {
  schema: 1,
  checked: 3,
  packages: [
    { name: 'dsh-foo', source: 'npm', installedVersion: '1.5.0', latestVersion: '1.7.2' },
  ],
}

/** 常用的完整路由：状态有更新、releases 有内容、插件有一个可更新。 */
function fullRoutes(): Record<string, (init: FakeInit) => FakeResponse> {
  return {
    'GET /dsh-upgrade/api/status': () => jsonResponse(SURVEY_UPDATE),
    'GET /dsh-upgrade/api/releases': () => jsonResponse(RELEASES),
    'GET /dsh-market/api/v1/updates/summary': () => jsonResponse(MARKET),
  }
}

function hostSection(): Element | null {
  return document.querySelector('.dshu-section[data-k="host"]')
}

function pluginsSection(): Element | null {
  return document.querySelector('.dshu-section[data-k="plugins"]')
}

/** 把渲染出来的插件行还原成 PluginRowView，供 paintBatchItem 的单态用例直接驱动。 */
function pluginRowView(name: string): PluginRowView {
  const root = document.querySelector<HTMLElement>('.dshu-plugin[data-name="' + name + '"]')
  if (root === null) throw new Error('missing plugin row: ' + name)
  const pick = (selector: string): HTMLElement => {
    const el = root.querySelector<HTMLElement>(selector)
    if (el === null) throw new Error('missing ' + selector)
    return el
  }
  return {
    root,
    name: pick('.dshu-plugin-name'),
    version: pick('.dshu-plugin-version'),
    state: pick('.dshu-plugin-state'),
    bar: pick('.dshu-bar'),
    fill: pick('.dshu-bar-fill'),
    progress: pick('.dshu-plugin-progress'),
    progressText: pick('.dshu-plugin-progress-text'),
  }
}

function upgradeButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.dshu-upgrade-btn')
}

function errorBar(): Element | null {
  return document.querySelector('.dshu-error')
}

function noticeText(): string {
  return document.querySelector('.dshu-notice')?.textContent ?? ''
}

function textOf(selector: string): string {
  return document.querySelector(selector)?.textContent ?? ''
}

afterEach(() => {
  closePanel()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const style of Array.from(document.querySelectorAll('style'))) style.remove()
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

describe('面板骨架与本体段', () => {
  test('打两段、本体段带当前版本与目标版本，更新内容可折叠', async () => {
    const calls = serve(fullRoutes())

    await openPanel(document, { apiBase: '' })

    expect(document.querySelector('.dshu-panel')).not.toBeNull()
    expect(hostSection()).not.toBeNull()
    expect(pluginsSection()).not.toBeNull()

    const hostText = hostSection()?.textContent ?? ''
    expect(hostText).toContain('0.2.2-rc.5')
    expect(hostText).toContain('0.2.3-alpha.2')

    // 更新内容折叠区：一条 .dshu-release，折叠头是 button。
    const release = document.querySelector('.dshu-release')
    expect(release).not.toBeNull()
    expect(release?.querySelector('button')).not.toBeNull()
    const releaseText = release?.textContent ?? ''
    expect(releaseText).toContain('新增升级面板')

    // 状态、releases、插件列表各自只打一次，且都带请求门要求的头。
    const statusCalls = callsTo(calls, 'GET', '/dsh-upgrade/api/status')
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0]?.headers['x-dsh-upgrade']).toBe('1')
    const releaseCalls = callsTo(calls, 'GET', '/dsh-upgrade/api/releases')
    expect(releaseCalls).toHaveLength(1)
    expect(releaseCalls[0]?.url).toContain('from=0.2.2-rc.5')
    expect(releaseCalls[0]?.url).toContain('to=0.2.3-alpha.2')
    const marketCalls = callsTo(calls, 'GET', '/dsh-market/api/v1/updates/summary')
    expect(marketCalls).toHaveLength(1)

    closePanel()
  })

  test('发布页链接只接受 http(s)，javascript: 不写进 href', async () => {
    serve({
      ...fullRoutes(),
      'GET /dsh-upgrade/api/releases': () =>
        jsonResponse({
          releases: [
            {
              version: '0.2.3-alpha.2',
              channel: 'alpha',
              publishedAt: '2026-11-20T10:00:00Z',
              items: ['新增升级面板'],
              url: 'javascript:alert(1)',
            },
          ],
          degraded: false,
        }),
    })

    await openPanel(document)

    const links = Array.from(document.querySelectorAll('.dshu-release a'))
    const unsafe = links.filter((link) => (link.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:'))
    expect(unsafe).toHaveLength(0)
    expect(document.querySelector('.dshu-release')?.textContent ?? '').toContain('新增升级面板')

    closePanel()
  })

  test('没有更新时本体段显示已是最新、升级按钮消失、段落还在', async () => {
    const calls = serve({
      ...fullRoutes(),
      'GET /dsh-upgrade/api/status': () =>
        jsonResponse({ ...SURVEY_UPDATE, target: '0.2.2-rc.5', includePrerelease: false }),
    })

    await openPanel(document)

    expect(hostSection()).not.toBeNull()
    expect(hostSection()?.textContent).toContain('已是最新')
    expect(upgradeButton()).toBeNull()
    expect(pluginsSection()).not.toBeNull()
    expect(callsTo(calls, 'GET', '/dsh-upgrade/api/releases')).toHaveLength(0)

    closePanel()
  })

  test('升级装完没重启：显示「需重启」而不是「已是最新」，角标仍亮、无升级按钮', async () => {
    serve({
      ...fullRoutes(),
      'GET /dsh-upgrade/api/status': () =>
        jsonResponse({ ...SURVEY_UPDATE, target: SURVEY_UPDATE.current, restartRequired: true }),
    })
    const states: Array<{ hasUpdate: boolean }> = []

    await openPanel(document, { onState: (state) => states.push({ hasUpdate: state.hasUpdate }) })

    const text = hostSection()?.textContent ?? ''
    expect(text).toContain('需重启')
    expect(text).toContain('0.2.2-rc.5')
    expect(text).not.toContain('已是最新')
    expect(upgradeButton()).toBeNull()
    // 角标靠 onState 的 hasUpdate 亮灭：这里必须仍是「有更新」。
    expect(states.at(-1)?.hasUpdate).toBe(true)

    closePanel()
  })

  test('probeHasUpdate 把「装完没重启」也算作有更新', async () => {
    serve({
      ...fullRoutes(),
      'GET /dsh-upgrade/api/status': () =>
        jsonResponse({ ...SURVEY_UPDATE, target: SURVEY_UPDATE.current, restartRequired: true }),
    })

    await expect(probeHasUpdate(document)).resolves.toBe(true)
  })

  test('target 为 null 也按无更新处理', async () => {
    serve({
      ...fullRoutes(),
      'GET /dsh-upgrade/api/status': () => jsonResponse({ ...SURVEY_UPDATE, target: null }),
    })

    await openPanel(document)

    expect(hostSection()?.textContent).toContain('已是最新')
    expect(upgradeButton()).toBeNull()

    closePanel()
  })

  test('engines 被拦时按钮 disabled、文案含「需要 Node」', async () => {
    serve({
      ...fullRoutes(),
      'GET /dsh-upgrade/api/status': () =>
        jsonResponse({
          ...SURVEY_UPDATE,
          blocked: { code: 'RUNTIME_UNSUPPORTED', message: '需要 Node ^24.22.3 || >=26.13.1，本机 26.7.0' },
        }),
    })

    await openPanel(document)

    const button = upgradeButton()
    expect(button).not.toBeNull()
    expect(button?.disabled).toBe(true)
    expect(button?.textContent ?? '').toContain('需要 Node')
    expect(hostSection()?.textContent ?? '').toContain('需要 Node')

    closePanel()
  })
})

describe('插件段', () => {
  test('market 不可用时插件段显示「插件更新不可用」，本体段照常', async () => {
    serve({
      ...fullRoutes(),
      'GET /dsh-market/api/v1/updates/summary': () => jsonResponse({ code: 'UNAUTHORIZED' }, 401),
    })

    await openPanel(document)

    expect(pluginsSection()?.textContent).toContain('插件更新不可用')
    expect(hostSection()?.textContent).toContain('0.2.3-alpha.2')

    closePanel()
  })

  test('有插件更新时逐行给版本对，没有更新时显示已是最新', async () => {
    serve(fullRoutes())
    await openPanel(document)

    const row = document.querySelector('.dshu-plugin')
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('1.5.0')
    expect(row?.textContent).toContain('1.7.2')
    expect(pluginsSection()?.textContent).toContain('1 个可更新')
    closePanel()

    serve({
      ...fullRoutes(),
      'GET /dsh-market/api/v1/updates/summary': () => jsonResponse({ schema: 1, checked: 3, packages: [] }),
    })
    await openPanel(document)
    expect(pluginsSection()?.textContent).toContain('已是最新')
    expect(document.querySelector('.dshu-plugin')).toBeNull()
    closePanel()
  })

  test('插件行是两行结构：第一行名字与版本，第二行自己的进度', async () => {
    serve(fullRoutes())
    await openPanel(document)

    const row = document.querySelector('.dshu-plugin')
    expect(row).not.toBeNull()
    const line = row?.querySelector('.dshu-plugin-line')
    expect(line).not.toBeNull()
    expect(line?.querySelector('.dshu-plugin-name')?.textContent).toBe('dsh-foo')
    const version = line?.querySelector('.dshu-plugin-version')?.textContent ?? ''
    expect(version).toContain('1.5.0')
    expect(version).toContain('1.7.2')

    // 第二行是自己的进度：进度块是行的最后一个直接子节点，默认收起。
    const progress = row?.querySelector('.dshu-plugin-progress')
    expect(progress).not.toBeNull()
    expect(row?.lastElementChild).toBe(progress)
    expect((progress as HTMLElement | null)?.hidden).toBe(true)
    closePanel()
  })

  test('版本是 40 位 commit 时只显示短哈希，全文留在 title 里', async () => {
    const from = '08f9424697e531a03918e3c60298366f2fb93b50'
    const to = 'ab4f8cd461cdf735b758385407a11679a60c0e86'
    serve({
      ...fullRoutes(),
      'GET /dsh-market/api/v1/updates/summary': () => jsonResponse({
        schema: 1,
        checked: 3,
        packages: [{ name: 'dsh-upgrade', source: 'github', installedVersion: from, latestVersion: to }],
      }),
    })
    await openPanel(document)
    const version = document.querySelector<HTMLElement>('.dshu-plugin[data-name="dsh-upgrade"] .dshu-plugin-version')
    expect(version?.textContent).toBe('08f9424 → ab4f8cd')
    expect(version?.title).toBe(from + ' → ' + to)
    closePanel()
  })

  test('插件行不再自带升级按钮', async () => {
    serve(fullRoutes())
    await openPanel(document)

    expect(document.querySelector('.dshu-plugin-upgrade')).toBeNull()
    closePanel()
  })

  test('两个都是 40 位 commit 时，用服务端查到的版本号替换短哈希', async () => {
    const from = '08f9424697e531a03918e3c60298366f2fb93b50'
    const to = 'ab4f8cd461cdf735b758385407a11679a60c0e86'
    const calls = serve({
      ...fullRoutes(),
      'GET /dsh-market/api/v1/updates/summary': () => jsonResponse({
        schema: 1,
        checked: 1,
        packages: [{ name: 'dsh-upgrade', source: 'github', installedVersion: from, latestVersion: to }],
      }),
      'GET /dsh-upgrade/api/plugin-version': () => jsonResponse({ installed: '0.2.1', latest: '0.2.2' }),
    })
    await openPanel(document)
    const version = document.querySelector<HTMLElement>('.dshu-plugin[data-name="dsh-upgrade"] .dshu-plugin-version')
    await vi.waitFor(() => expect(version?.textContent).toBe('0.2.1 → 0.2.2'))
    expect(version?.title).toBe(from + ' → ' + to)
    const asked = calls.find((call) => pathOf(call.url) === '/dsh-upgrade/api/plugin-version')
    expect(asked?.headers['x-dsh-upgrade']).toBe('1')
    closePanel()
  })

  test('两端版本相同时写「仅提交变化」，不装作有版本升级', async () => {
    const from = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const to = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    serve({
      ...fullRoutes(),
      'GET /dsh-market/api/v1/updates/summary': () => jsonResponse({
        schema: 1,
        checked: 1,
        packages: [{ name: 'dsh-upgrade', source: 'github', installedVersion: from, latestVersion: to }],
      }),
      'GET /dsh-upgrade/api/plugin-version': () => jsonResponse({ installed: '0.2.1', latest: '0.2.1' }),
    })
    await openPanel(document)
    const version = document.querySelector<HTMLElement>('.dshu-plugin[data-name="dsh-upgrade"] .dshu-plugin-version')

    await vi.waitFor(() => expect(version?.textContent).toBe('0.2.1（仅提交变化）'))
    closePanel()
  })

  test('查不到版本号就保持短哈希，不报错', async () => {
    const from = 'cccccccccccccccccccccccccccccccccccccccc'
    const to = 'dddddddddddddddddddddddddddddddddddddddd'
    serve({
      ...fullRoutes(),
      'GET /dsh-market/api/v1/updates/summary': () => jsonResponse({
        schema: 1,
        checked: 1,
        packages: [{ name: 'dsh-upgrade', source: 'github', installedVersion: from, latestVersion: to }],
      }),
      'GET /dsh-upgrade/api/plugin-version': () => jsonResponse({ installed: null, latest: null }),
    })
    await openPanel(document)
    const version = document.querySelector<HTMLElement>('.dshu-plugin[data-name="dsh-upgrade"] .dshu-plugin-version')

    await vi.waitFor(() => expect(version?.textContent).toBe('ccccccc → ddddddd'))
    expect(document.querySelector('.dshu-error')).toBeNull()
    closePanel()
  })

  test('版本本来就是版本号时不发这个请求', async () => {
    const calls = serve(fullRoutes())
    await openPanel(document)
    const asked = calls.filter((call) => pathOf(call.url) === '/dsh-upgrade/api/plugin-version')
    expect(asked).toHaveLength(0)
    closePanel()
  })


  test('running 时进度块露出来，终态后收回', async () => {
    serve(fullRoutes())
    await openPanel(document)
    const row = pluginRowView('dsh-foo')
    expect(row.progress.hidden).toBe(true)

    paintBatchItem(row, {
      name: 'dsh-foo',
      state: 'running',
      percent: 43,
      detail: '正在解析依赖 ' + 'x'.repeat(120),
      message: null,
      unavailable: false,
    })

    expect(row.progress.hidden).toBe(false)
    expect(row.bar.hidden).toBe(false)
    expect(row.fill.style.width).toBe('43%')
    // 没有状态句时 state 整行收起，进度块与版本行之间不留空缝。
    expect(row.state.hidden).toBe(true)
    // pnpm 的整行输出压成一句，行高不会忽上忽下。
    expect((row.progressText.textContent ?? '').length).toBe(90)

    paintBatchItem(row, {
      name: 'dsh-foo',
      state: 'succeeded',
      percent: null,
      detail: null,
      message: null,
      unavailable: false,
    })

    expect(row.progress.hidden).toBe(true)
    expect(row.bar.hidden).toBe(true)
    expect(row.state.hidden).toBe(false)
    expect(row.state.textContent).toBe('已升级')
    closePanel()
  })

  test('排队卡住只说「还没开始升级」，不补前缀、不上红字', async () => {
    serve(fullRoutes())
    await openPanel(document)
    const row = pluginRowView('dsh-foo')
    const message = '还没开始升级：等 2 个运行中的会话结束后再点'

    paintBatchItem(row, {
      name: 'dsh-foo',
      state: 'failed',
      percent: null,
      detail: null,
      message,
      unavailable: false,
    })

    expect(row.state.textContent).toBe(message)
    expect(row.state.textContent ?? '').not.toContain('升级失败：')
    expect(row.state.hasAttribute('data-error')).toBe(false)
    expect(row.progress.hidden).toBe(true)
    closePanel()
  })

  test('回滚文案只留中文首句，title 里保留英文全文', async () => {
    serve(fullRoutes())
    await openPanel(document)
    const row = pluginRowView('dsh-foo')
    const zh = '装完版本对不上，已经换回旧版本，请稍后再试。'
    const en = 'The installed version does not match; rolled back to the previous version.'

    paintBatchItem(row, {
      name: 'dsh-foo',
      state: 'failed',
      percent: null,
      detail: null,
      message: '已回滚：' + zh + ' / ' + en,
      unavailable: false,
    })

    const shown = row.state.textContent ?? ''
    expect(shown.startsWith('已回滚：')).toBe(true)
    expect(shown).not.toContain('The installed version')
    expect(shown).not.toContain('升级失败：')
    expect(row.state.getAttribute('title')).toContain(en)
    closePanel()
  })
})

describe('全部升级', () => {
  test('全部升级按钮与插件标题同一行，点下去按列表顺序串行起包', async () => {
    const calls = serve(batchRoutes({ packages: ['a', 'b'] }))
    await openPanel(document)

    const button = document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('全部升级')
    const head = document.querySelector('.dshu-plugins-head')
    expect(head).not.toBeNull()
    expect(button?.parentElement).toBe(head)
    expect(head?.querySelector('.dshu-plugin-head')?.textContent).toContain('插件（2 个可更新）')
    // 列表换行在下面，不能挤进标题这一行。
    const list = document.querySelector('.dshu-plugin-list')
    expect(list).not.toBeNull()
    expect(head?.contains(list)).toBe(false)
    expect(button?.parentElement?.children).not.toContain(list)

    button?.click()
    await waitFor(() => callsTo(calls, 'POST', '/dsh-market/api/v1/updates').length === 2)
    expect(callsTo(calls, 'POST', '/dsh-market/api/v1/updates').map((call) => call.body)).toEqual([
      { packageName: 'a' },
      { packageName: 'b' },
    ])
    closePanel()
  })

  test('全部升完后「全部升级」收起，标题回到「插件」，只留重启', async () => {
    const calls = serve({
      ...batchRoutes({ packages: ['a', 'b'] }),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden === false)

    // 没有可更新的包了：按钮整颗收起，标题不再挂「N 个可更新」。
    expect(document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.hidden).toBe(true)
    expect(document.querySelector('.dshu-plugin-head')?.textContent).toBe('插件')
    expect(document.querySelector('.dshu-plugin-summary')?.textContent).toContain('2 个已升级')
    expect(callsTo(calls, 'POST', '/dsh-market/api/v1/updates')).toHaveLength(2)
    closePanel()
  })

  test('部分失败时按钮改成「继续升级」，只重试失败的那个包', async () => {
    const calls = serve({
      ...batchRoutes({
        packages: ['a', 'b'],
        steps: {
          a: [{ state: 'succeeded' }],
          b: [{ state: 'failed', failure: { code: 'INSTALL_FAILED', message: '磁盘写满' } }],
        },
      }),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.textContent === '继续升级')

    // 升成的 a 从可更新表里摘掉：标题、按钮、重试名单三处口径一致。
    expect(document.querySelector('.dshu-plugin-head')?.textContent).toContain('插件（1 个可更新）')
    expect(document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden).toBe(false)
    const button = document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')
    expect(button?.disabled).toBe(false)

    button?.click()
    await waitFor(() => callsTo(calls, 'POST', '/dsh-market/api/v1/updates').length === 3)
    // 只补那一个失败的包，已升好的 a 不再动。
    expect(callsTo(calls, 'POST', '/dsh-market/api/v1/updates').map((call) => call.body)).toEqual([
      { packageName: 'a' },
      { packageName: 'b' },
      { packageName: 'b' },
    ])
    closePanel()
  })

  test('升级中按钮与本体控件一起按住，结束全部恢复', async () => {
    const steps: Record<string, OperationStep[]> = { a: [{ state: 'running', percent: 10 }] }
    serve(batchRoutes({ packages: ['a', 'b'], steps }))
    await openPanel(document, { pollIntervalMs: 10 })

    const button = document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')
    const toggle = document.querySelector<HTMLInputElement>('.dshu-prerelease')
    const refresh = document.querySelector<HTMLButtonElement>('.dshu-refresh')
    const host = upgradeButton()
    expect(host).not.toBeNull()

    button?.click()
    await waitFor(() => button?.disabled === true)
    expect(button?.textContent).toBe('升级中…')
    expect(toggle?.disabled).toBe(true)
    expect(refresh?.disabled).toBe(true)
    expect(host?.disabled).toBe(true)

    steps['a']?.push({ state: 'succeeded' })
    await waitFor(() => button?.disabled === false)
    expect(button?.textContent).toBe('全部升级')
    expect(toggle?.disabled).toBe(false)
    expect(refresh?.disabled).toBe(false)
    expect(host?.disabled).toBe(false)
    closePanel()
  })

  test('每个插件只画自己那一行的进度', async () => {
    const steps: Record<string, OperationStep[]> = {
      a: [
        { state: 'running', percent: 42.6 },
        { state: 'running', percent: 42.6 },
        { state: 'running', percent: 42.6 },
        { state: 'succeeded' },
      ],
      b: [{ state: 'succeeded' }],
    }
    serve(batchRoutes({ packages: ['a', 'b'], steps }))
    await openPanel(document, { pollIntervalMs: 20 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(
      () => document.querySelector<HTMLElement>('[data-name="a"] .dshu-bar-fill')?.style.width === '43%',
    )
    expect(document.querySelector<HTMLElement>('[data-name="b"] .dshu-bar')?.hidden).toBe(true)
    closePanel()
  })

  test('中途失败继续升后面的，最后一行把数说清', async () => {
    serve(batchRoutes({
      packages: ['a', 'b', 'c'],
      steps: {
        a: [{ state: 'succeeded' }],
        b: [{ state: 'failed', failure: { code: 'INSTALL_FAILED', message: '磁盘写满' } }],
        c: [{ state: 'succeeded' }],
      },
    }))
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => (document.querySelector('.dshu-plugin-summary')?.textContent ?? '').includes('1 个失败'))

    const failed = document.querySelector<HTMLElement>('[data-name="b"] .dshu-plugin-state')
    expect(failed?.hasAttribute('data-error')).toBe(true)
    expect(failed?.textContent).toContain('磁盘写满')
    expect(document.querySelector('[data-name="c"] .dshu-plugin-state')?.textContent).toBe('已升级')
    const summary = document.querySelector<HTMLElement>('.dshu-plugin-summary')
    expect(summary?.hidden).toBe(false)
    expect(summary?.textContent).toContain('2 个已升级')
    expect(summary?.textContent).toContain('1 个失败')
    closePanel()
  })

  test('AGENTS_RUNNING 的双语只留中文首句，英文全文进 title', async () => {
    const message =
      '有 agent 正在运行（session-abc）。更新会直接替换插件文件，先等它结束。 / ' +
      'Agents are running (session-abc). Updating replaces plugin files in place; wait for it to finish.'
    serve(batchRoutes({
      packages: ['a'],
      steps: { a: [{ state: 'failed', failure: { code: 'AGENTS_RUNNING', message } }] },
    }))
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => (document.querySelector('[data-name="a"] .dshu-plugin-state')?.textContent ?? '') !== '')

    const state = document.querySelector<HTMLElement>('[data-name="a"] .dshu-plugin-state')
    expect(state?.textContent).toContain('有 agent 正在运行')
    expect(state?.textContent).not.toContain('Agents are running')
    expect(state?.getAttribute('title')).toContain('Agents are running')
    closePanel()
  })

  test('请求层不可用只说不熟，不画成安装失败的红字', async () => {
    serve(batchRoutes({ packages: ['a'], postStatus: 500 }))
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(
      () => document.querySelector('[data-name="a"] .dshu-plugin-state')?.textContent === '插件更新不可用',
    )

    const state = document.querySelector<HTMLElement>('[data-name="a"] .dshu-plugin-state')
    expect(state?.hasAttribute('data-error')).toBe(false)
    closePanel()
  })

  test('批量进行中关面板：剩下的包不再发请求，也不抛错', async () => {
    const calls = serve(batchRoutes({
      packages: ['a', 'b'],
      // 第一个包成功那一刻就关面板：批量循环在同一串微任务里立刻会去起第二个包，
      // 从 DOM 外面等「已升级」再关是来不及的。
      onPoll: (name, index) => {
        if (name === 'a' && index === 0) closePanel()
      },
    }))
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => callsTo(calls, 'POST', '/dsh-market/api/v1/updates').length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(callsTo(calls, 'POST', '/dsh-market/api/v1/updates')).toHaveLength(1)
    expect(document.querySelector('.dshu-overlay')).toBeNull()
  })

  test('排队时行里说清在等几个运行中的会话', async () => {
    serve(batchRoutes({
      packages: ['a'],
      steps: {
        a: [
          {
            state: 'queued',
            wait: { code: 'AGENTS_RUNNING', message: '有 agent 正在运行', activeAgentIds: ['s1', 's2'] },
          },
          { state: 'succeeded' },
        ],
      },
    }))
    await openPanel(document, { pollIntervalMs: 40 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() =>
      (document.querySelector('[data-name="a"] .dshu-plugin-progress-text')?.textContent ?? '').includes(
        '等 2 个运行中的会话结束',
      ),
    )
    closePanel()
  })

  test('点「继续升级」的瞬间先清掉上一轮的残留文案', async () => {
    const steps: Record<string, OperationStep[]> = { a: [{ state: 'failed', failure: { code: 'INSTALL_FAILED', message: '磁盘写满' } }] }
    serve(batchRoutes({ packages: ['a'], steps }))
    await openPanel(document, { pollIntervalMs: 10 })

    const button = document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')
    button?.click()
    await waitFor(() =>
      (document.querySelector('[data-name="a"] .dshu-plugin-state')?.textContent ?? '').includes('磁盘写满'),
    )
    await waitFor(() => button?.textContent === '继续升级')
    expect(button?.hidden).toBe(false)

    steps['a']?.push({ state: 'succeeded' })
    button?.click()
    // 同步断言：第一次 await 之前就得把上一轮画的东西清掉。
    expect(document.querySelector<HTMLElement>('[data-name="a"] .dshu-plugin-state')?.textContent).toBe('')
    expect(document.querySelector<HTMLElement>('[data-name="a"] .dshu-plugin-progress')?.hidden).toBe(true)
    closePanel()
  })

  test('「继续升级」只重跑失败的包，已升级那几行的结果留着', async () => {
    const steps: Record<string, OperationStep[]> = {
      a: [{ state: 'succeeded' }],
      b: [{ state: 'failed', failure: { code: 'INSTALL_FAILED', message: '磁盘写满' } }],
      c: [{ state: 'succeeded' }],
    }
    serve(batchRoutes({ packages: ['a', 'b', 'c'], steps }))
    await openPanel(document, { pollIntervalMs: 10 })

    const button = document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')
    button?.click()
    await waitFor(() => button?.textContent === '继续升级')
    // 首轮收尾：a / c 已升级，b 红字。
    expect(document.querySelector('[data-name="a"] .dshu-plugin-state')?.textContent).toBe('已升级')
    expect(document.querySelector('[data-name="c"] .dshu-plugin-state')?.textContent).toBe('已升级')

    steps['b']?.push({ state: 'succeeded' })
    button?.click()
    // 同步断言：这一轮只碰 b，a / c 上一轮的结论不能被清掉。
    expect(document.querySelector('[data-name="a"] .dshu-plugin-state')?.textContent).toBe('已升级')
    expect(document.querySelector('[data-name="c"] .dshu-plugin-state')?.textContent).toBe('已升级')
    expect(document.querySelector('[data-name="b"] .dshu-plugin-state')?.textContent).toBe('')
    closePanel()
  })

  test('本体状态晚到：先点了全部升级，新出的本体按钮也是禁用的', async () => {
    let releaseStatus!: (value: FakeResponse) => void
    const gate = new Promise<FakeResponse>((resolve) => {
      releaseStatus = resolve
    })
    const routes = batchRoutes({ packages: ['a'], steps: { a: [{ state: 'running', percent: 10 }] } })
    routes['GET /dsh-upgrade/api/status'] = () => gate
    serve(routes)

    const opening = openPanel(document, { pollIntervalMs: 40 })
    // 等插件列表渲染完：按钮创建时默认可见，hidden 不能当作「数据到了」的信号。
    await waitFor(() => document.querySelector('.dshu-plugin[data-name="a"]') !== null)
    const all = document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')
    all?.click()
    await waitFor(() => all?.disabled === true)
    expect(upgradeButton()).toBeNull()

    releaseStatus(jsonResponse(SURVEY_UPDATE))
    await waitFor(() => upgradeButton() !== null)
    expect(upgradeButton()?.disabled).toBe(true)
    await opening
    closePanel()
  })

  test('中途遇到宿主已有升级：本包失败，后面的记跳过，且不再发请求', async () => {
    const calls = serve(batchRoutes({
      packages: ['a', 'b', 'c'],
      postFailures: { b: { status: 409, code: 'OPERATION_BUSY', message: '已有升级在跑' } },
    }))
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => (document.querySelector('.dshu-plugin-summary')?.textContent ?? '').includes('跳过'))

    const summary = document.querySelector<HTMLElement>('.dshu-plugin-summary')
    expect(summary?.textContent).toBe('1 个已升级，1 个失败，1 个跳过')
    expect(callsTo(calls, 'POST', '/dsh-market/api/v1/updates')).toHaveLength(2)
    expect(document.querySelector('[data-name="c"] .dshu-plugin-state')?.textContent).toBe('已跳过')
    // 失败原因留在汇总行，底栏不冒红条。
    expect(errorBar()).toBeNull()
    closePanel()
  })

  test('有包要求重启时，汇总里说清需重启生效', async () => {
    serve(batchRoutes({
      packages: ['a'],
      steps: { a: [{ state: 'succeeded', restartRequired: true }] },
    }))
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => (document.querySelector('.dshu-plugin-summary')?.textContent ?? '').includes('需重启生效'))

    expect(document.querySelector('.dshu-plugin-summary')?.textContent).toBe('1 个已升级，需重启生效')
    closePanel()
  })

  test('没有可更新的插件时不显示「全部升级」', async () => {
    serve(batchRoutes({ packages: [] }))
    await openPanel(document)

    expect(document.querySelector('.dshu-plugin-empty')?.textContent).toBe('已是最新')
    expect(document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.hidden).toBe(true)
    closePanel()
  })

  test('本体升级进行中，「全部升级」是禁用的', async () => {
    serve(batchRoutes({ packages: ['a'] }))
    await openPanel(document)
    await waitFor(() => upgradeButton() !== null)

    upgradeButton()?.click()
    // runHostUpgrade 在第一个 await 之前就把忙态置上了。
    expect(document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.disabled).toBe(true)
    closePanel()
  })
})

describe('全部升级后的重启', () => {
  test('批量成功且 dsh-restart 可用时，重启按钮与标题同行出现', async () => {
    serve({
      ...batchRoutes({ packages: ['a'] }),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('.dshu-restart')
      return button !== null && button.hidden === false
    })

    const button = document.querySelector<HTMLButtonElement>('.dshu-restart')
    expect(button?.textContent).toBe('重启 DSH')
    expect(button?.disabled).toBe(false)
    expect(button?.parentElement).toBe(document.querySelector('.dshu-plugins-head'))
    expect(document.querySelector('.dshu-plugin-summary')?.textContent).toBe('1 个已升级')
    closePanel()
  })

  test('没装 dsh-restart 时不露重启按钮，提示手动重启', async () => {
    serve(batchRoutes({ packages: ['a'] }))
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => noticeText().includes('需手动重启'))

    expect(document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden).toBe(true)
    expect(noticeText()).toContain('插件已升级')
    closePanel()
  })

  test('批量后连不上 dsh-restart：说清网络失败，不冒充「没装」', async () => {
    serve({
      ...batchRoutes({ packages: ['a'] }),
      'GET /dsh-restart/api/status': () => {
        throw new Error('offline')
      },
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => noticeText().includes('连不上 dsh-restart'))

    expect(noticeText()).toContain('插件已升级')
    expect(noticeText()).toContain('需手动重启')
    expect(noticeText()).not.toContain('重启不可用')
    expect(document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden).toBe(true)
    closePanel()
  })

  test('点重启要二次确认：冷却 800ms 内的连点不发请求，冷却后确认才预检', async () => {
    const streams: { precheck: ReturnType<typeof controlledStream> | null } = { precheck: null }
    const calls = serve({
      ...batchRoutes({ packages: ['a'] }),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
      'POST /dsh-restart/api/precheck': () => {
        const stream = controlledStream()
        streams.precheck = stream
        return stream.response
      },
      'POST /dsh-restart/api/restart': () => jsonResponse({ ok: true }, 202),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => {
      const shown = document.querySelector<HTMLButtonElement>('.dshu-restart')
      return shown !== null && shown.hidden === false
    })
    const button = document.querySelector<HTMLButtonElement>('.dshu-restart')
    if (button === null) throw new Error('没有重启按钮')

    // 冷却判定用 Date.now，必须从第一下点击起就由假时钟接管。
    vi.useFakeTimers()
    button.click()
    // 第一下：只进入确认态，一个请求都不发。
    expect(callsTo(calls, 'POST', '/dsh-restart/api/precheck')).toHaveLength(0)
    expect(button.textContent).toBe('确认重启？')
    expect(button.disabled).toBe(false)
    expect(noticeText()).toContain('再点一次')

    // 同 tick 的第二下（误双击）必须完全忽略：不改文案、不发请求。
    button.click()
    expect(button.textContent).toBe('确认重启？')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/precheck')).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(799)
    button.click()
    expect(button.textContent).toBe('确认重启？')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/precheck')).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    button.click()
    expect(button.textContent).toBe('重启中…')
    expect(button.disabled).toBe(true)
    vi.useRealTimers()
    await waitFor(() => callsTo(calls, 'POST', '/dsh-restart/api/precheck').length === 1)
    expect(callsTo(calls, 'POST', '/dsh-restart/api/precheck')).toHaveLength(1)

    const liveStream = (): ReturnType<typeof controlledStream> => {
      if (streams.precheck === null) throw new Error('预检请求还没发出去')
      return streams.precheck
    }
    liveStream().push('{"stage":"config","ok":true,"failures":[]}\n')
    liveStream().push('{"stage":"compat","ok":true,"failures":[]}\n')
    liveStream().push('{"stage":"boot","ok":true,"failures":[]}\n')
    liveStream().push('{"done":true}\n')
    liveStream().close()

    await waitFor(() => callsTo(calls, 'POST', '/dsh-restart/api/restart').length === 1)
    expect(callsTo(calls, 'POST', '/dsh-restart/api/precheck')[0]?.headers['x-dsh-restart']).toBe('1')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/restart')[0]?.headers['x-dsh-restart']).toBe('1')
    // 重启请求一发出就把面板收掉：服务马上要重启，别留一块点不动的面板。
    await waitFor(() => document.querySelector('[data-dshu-panel]') === null)
    closePanel()
  })

  test('冷却窗口内被「重新检查」复位后，下一次点击仍然是第一下', async () => {
    const calls = serve({
      ...batchRoutes({ packages: ['a'] }),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden === false)
    const button = document.querySelector<HTMLButtonElement>('.dshu-restart')
    if (button === null) throw new Error('没有重启按钮')

    vi.useFakeTimers()
    button.click()
    expect(button.textContent).toBe('确认重启？')

    await vi.advanceTimersByTimeAsync(800)
    document.querySelector<HTMLButtonElement>('.dshu-refresh')?.click()
    expect(button.textContent).toBe('重启 DSH')

    // 冷却已过，但确认意图已被复位：这一下仍只是第一下。
    button.click()
    expect(button.textContent).toBe('确认重启？')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/precheck')).toHaveLength(0)
    vi.useRealTimers()
    closePanel()
  })

  test('重启链在途时「全部升级」被按住，链结束后恢复', async () => {
    let statusCalls = 0
    let releaseStatus!: (value: FakeResponse) => void
    const gate = new Promise<FakeResponse>((resolve) => {
      releaseStatus = resolve
    })
    const routes = batchRoutes({ packages: ['a'] })
    routes['GET /dsh-restart/api/status'] = () => {
      statusCalls += 1
      return statusCalls === 1 ? jsonResponse({ ok: true, health: true, port: 3080 }) : gate
    }
    const calls = serve(routes)
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden === false)
    const button = document.querySelector<HTMLButtonElement>('.dshu-restart')
    await confirmRestart(button)
    await waitFor(() => statusCalls >= 2)

    const all = document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')
    expect(all?.disabled).toBe(true)
    // 文案保持不变；只有批量自己在跑时才写「升级中…」。
    expect(all?.textContent).toBe('全部升级')
    expect(document.querySelector<HTMLButtonElement>('.dshu-refresh')?.disabled).toBe(true)
    expect(document.querySelector<HTMLInputElement>('.dshu-prerelease')?.disabled).toBe(true)

    // 链在途时再点：不能起第二轮批量（此前那一轮的 1 次 POST 是基线）。
    all?.click()
    expect(callsTo(calls, 'POST', '/dsh-market/api/v1/updates')).toHaveLength(1)

    releaseStatus(jsonResponse({ code: 'NOT_FOUND', message: '没有 dsh-restart' }, 404))
    await waitFor(() => noticeText().includes('没找到 dsh-restart'))
    expect(all?.disabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('.dshu-refresh')?.disabled).toBe(false)
    expect(document.querySelector<HTMLInputElement>('.dshu-prerelease')?.disabled).toBe(false)
    expect(button?.disabled).toBe(false)
    expect(button?.textContent).toBe('重启 DSH')
    closePanel()
  })

  test('预检 409 时说清「已有一轮预检在进行」，不冒充升级失败', async () => {
    const calls = serve({
      ...batchRoutes({ packages: ['a'] }),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
      'POST /dsh-restart/api/precheck': () =>
        // 真实 dsh-restart 的非 2xx 形状是 { ok:false, error }，不是 message。
        jsonResponse({ ok: false, error: '已有一轮预检在进行' }, 409),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => {
      const shown = document.querySelector<HTMLButtonElement>('.dshu-restart')
      return shown !== null && shown.hidden === false
    })
    const button = document.querySelector<HTMLButtonElement>('.dshu-restart')
    await confirmRestart(button)

    await waitFor(() => noticeText().includes('预检失败'))
    expect(noticeText()).toContain('HTTP 409')
    expect(noticeText()).toContain('已有一轮预检在进行')
    expect(noticeText()).not.toContain('升级失败')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/restart')).toHaveLength(0)
    // 不是弹一次就消失的红条：通知留在面板里。
    expect(document.querySelector<HTMLElement>('.dshu-notice')?.hidden).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(noticeText()).toContain('预检失败')
    closePanel()
  })

  test('预检 200 但 body 为空：没拿到 done 就不重启', async () => {
    const calls = serve({
      ...batchRoutes({ packages: ['a'] }),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
      'POST /dsh-restart/api/precheck': () => textResponse(''),
      'POST /dsh-restart/api/restart': () => jsonResponse({ ok: true }, 202),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden === false)
    const button = document.querySelector<HTMLButtonElement>('.dshu-restart')
    await confirmRestart(button)

    await waitFor(() => noticeText().includes('预检没有返回结果'))
    expect(noticeText()).toContain('未重启')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/restart')).toHaveLength(0)
    closePanel()
  })

  test('预检流只有半截（有 started 无 done）：当失败，不重启', async () => {
    const calls = serve({
      ...batchRoutes({ packages: ['a'] }),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
      'POST /dsh-restart/api/precheck': () =>
        textResponse('{"stage":"config","ok":true,"failures":[]}\n'),
      'POST /dsh-restart/api/restart': () => jsonResponse({ ok: true }, 202),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden === false)
    const button = document.querySelector<HTMLButtonElement>('.dshu-restart')
    await confirmRestart(button)

    await waitFor(() => noticeText().includes('预检没有返回结果'))
    // 阶段提示只走蓝色提示框，不再往进度块里堆历史记录。
    expect(textOf('.dshu-progress')).toBe('')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/restart')).toHaveLength(0)
    closePanel()
  })

  test('预检阶段没过时，把阶段和原因留在面板里', async () => {
    const calls = serve({
      ...batchRoutes({ packages: ['a'] }),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
      'POST /dsh-restart/api/precheck': () =>
        textResponse('{"stage":"compat","ok":false,"failures":[{"kind":"compat","message":"插件 X 不兼容"}]}\n{"done":true}\n'),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => {
      const shown = document.querySelector<HTMLButtonElement>('.dshu-restart')
      return shown !== null && shown.hidden === false
    })
    const button = document.querySelector<HTMLButtonElement>('.dshu-restart')
    await confirmRestart(button)

    await waitFor(() => noticeText().includes('预检没通过'))
    expect(noticeText()).toContain('插件兼容检查')
    expect(noticeText()).toContain('插件 X 不兼容')
    expect(textOf('.dshu-progress')).toBe('')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/restart')).toHaveLength(0)
    expect(document.querySelector<HTMLElement>('.dshu-notice')?.hidden).toBe(false)
    closePanel()
  })

  test('一个包都没升成功时，不查重启也不露按钮', async () => {
    const calls = serve(batchRoutes({
      packages: ['a'],
      steps: { a: [{ state: 'failed', failure: { code: 'INSTALL_FAILED', message: '磁盘写满' } }] },
    }))
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => (document.querySelector('.dshu-plugin-summary')?.textContent ?? '').includes('1 个失败'))
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden).toBe(true)
    expect(callsTo(calls, 'GET', '/dsh-restart/api/status')).toHaveLength(0)
    closePanel()
  })

  test('dsh-restart 状态坏了：提示重启不可用（HTTP n），不露按钮', async () => {
    const calls = serve({
      ...batchRoutes({ packages: ['a'] }),
      'GET /dsh-restart/api/status': () => jsonResponse({ code: 'BOOM', message: '内部错误' }, 500),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => noticeText().includes('重启不可用（HTTP 500）'))

    expect(document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden).toBe(true)
    expect(callsTo(calls, 'POST', '/dsh-restart/api/restart')).toHaveLength(0)
    closePanel()
  })
  test('restart 409 后把按钮恢复可点，并说明已有重启在跑', async () => {
    const calls = serve({
      ...batchRoutes({ packages: ['a'] }),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
      'POST /dsh-restart/api/precheck': () =>
        textResponse('{"stage":"boot","ok":true,"failures":[]}\n{"done":true}\n'),
      'POST /dsh-restart/api/restart': () => jsonResponse({ ok: false, error: '已有一轮重启' }, 409),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden === false)
    const button = document.querySelector<HTMLButtonElement>('.dshu-restart')
    await confirmRestart(button)

    await waitFor(() => noticeText().includes('重启在进行'))
    expect(noticeText()).toContain('手动刷新')
    expect(button?.disabled).toBe(false)
    expect(button?.textContent).toBe('重启 DSH')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/restart')).toHaveLength(1)
    closePanel()
  })

  test('确认态被「重新检查」复位，不会留到下一次点击', async () => {
    const calls = serve({
      ...batchRoutes({ packages: ['a'] }),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
    })
    await openPanel(document, { pollIntervalMs: 10 })

    document.querySelector<HTMLButtonElement>('.dshu-upgrade-all')?.click()
    await waitFor(() => document.querySelector<HTMLButtonElement>('.dshu-restart')?.hidden === false)
    const button = document.querySelector<HTMLButtonElement>('.dshu-restart')
    button?.click()
    expect(button?.textContent).toBe('确认重启？')

    document.querySelector<HTMLButtonElement>('.dshu-refresh')?.click()
    expect(button?.textContent).toBe('重启 DSH')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/precheck')).toHaveLength(0)
    closePanel()
  })

})

describe('面板布局：头部固定、内容区滚动', () => {
  test('head 与 body 是兄弟节点，两段与错误条都在 body 里', async () => {
    serve(fullRoutes())

    await openPanel(document)

    const panel = document.querySelector('.dshu-panel')
    const head = document.querySelector('.dshu-head')
    const body = document.querySelector('.dshu-body')
    expect(head).not.toBeNull()
    expect(body).not.toBeNull()
    // 头部直接挂在面板上，不跟着内容滚；滚动容器只有 body。
    expect(head?.parentElement).toBe(panel)
    expect(body?.parentElement).toBe(panel)
    expect(body?.querySelector('.dshu-section[data-k="host"]')).not.toBeNull()
    expect(body?.querySelector('.dshu-section[data-k="plugins"]')).not.toBeNull()
    expect(body?.querySelector('.dshu-progress')).not.toBeNull()

    closePanel()
  })

  test('本体升级失败的红条也在 body 里，头部不动', async () => {
    serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () => jsonResponse({ code: 'NO_SPACE', message: '磁盘剩余空间不足' }, 400),
    })

    await openPanel(document)
    upgradeButton()?.click()

    await waitFor(() => errorBar() !== null)
    expect(document.querySelector('.dshu-body .dshu-error')).not.toBeNull()
    expect(errorBar()?.textContent).toContain('磁盘剩余空间不足')

    closePanel()
  })
})

describe('多行错误红条', () => {
  test('textContent 原样保留换行，样式用 pre-line 才看得出两行', async () => {
    // 服务端给的是「事实 + 可复制命令」两行；面板只负责原样放进 DOM
    const message =
      '安装目录不可写：/usr/local/lib/node_modules/@deepseek-ai/dsh（属主不是你），插件无法升级本体。\n' +
      '手动执行：sudo npm i -g --prefix /usr/local @deepseek-ai/dsh@0.2.3-alpha.2'
    serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () =>
        streamResponse([
          JSON.stringify({
            phase: 'fail',
            done: true,
            error: { code: 'INSTALL_DIR_NOT_WRITABLE', message },
          }) + '\n',
        ]),
    })

    await openPanel(document)
    upgradeButton()?.click()

    await waitFor(() => errorBar() !== null)
    // 不截断、不自己拼行：两行原文一个字都不少
    expect(errorBar()?.textContent).toBe(message)
    expect(errorBar()?.textContent?.split('\n')).toHaveLength(2)

    // 换行要靠 .dshu-error 的 white-space:pre-line 才看得见，单行红条不受影响
    const css = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n')
    expect(css).toMatch(/\.dshu-error\{[^}]*white-space:pre-line/)

    closePanel()
  })
})

describe('本体升级的 NDJSON 进度', () => {
  test('流式读到 done 后显示已升级；dsh-restart 404 时降级为需手动重启', async () => {
    const calls = serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () =>
        streamResponse(['{"phase":"backup","message":"正在备份"}\n', '{"phase":"done","done":true}\n']),
    })

    await openPanel(document)
    upgradeButton()?.click()

    await waitFor(() => textOf('.dshu-progress').includes('已升级到 0.2.3-alpha.2'))
    await waitFor(() => noticeText().includes('需手动重启'))

    const progress = textOf('.dshu-progress')
    expect(progress).toContain('备份')
    expect(progress).toContain('完成')
    expect(noticeText()).toContain('已升级到 0.2.3-alpha.2')
    expect(errorBar()).toBeNull()

    const upgradeCalls = callsTo(calls, 'POST', '/dsh-upgrade/api/upgrade')
    expect(upgradeCalls).toHaveLength(1)
    expect(upgradeCalls[0]?.headers['x-dsh-upgrade']).toBe('1')
    expect(upgradeCalls[0]?.headers['content-type']).toBe('application/json')
    expect(upgradeCalls[0]?.body).toEqual({ target: '0.2.3-alpha.2' })
    // 重启链没接上：一次 restart 请求都不该发。
    expect(callsTo(calls, 'POST', '/dsh-restart/api/restart')).toHaveLength(0)

    closePanel()
  })

  test('阶段进度条按 backup→install→done 推进，结束时收起', async () => {
    let stream: ReturnType<typeof controlledStream> | null = null
    serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () => {
        stream = controlledStream()
        return stream.response
      },
      'GET /dsh-restart/api/status': () => jsonResponse({ code: 'NOT_FOUND', message: '没有这个插件' }, 404),
    })

    const fillOf = (): string =>
      document.querySelector<HTMLElement>('.dshu-host-bar .dshu-bar-fill')?.style.width ?? ''
    const barOf = (): HTMLElement | null => document.querySelector<HTMLElement>('.dshu-host-bar')
    // 在箭头函数里读才拿得到声明类型：直接读会被 TS 收窄成 null 之外的空联合。
    const liveStream = (): ReturnType<typeof controlledStream> => {
      if (stream === null) throw new Error('升级请求还没发出去')
      return stream
    }
    const push = (text: string): void => liveStream().push(text)

    await openPanel(document)
    expect(barOf()?.hidden).toBe(true)
    upgradeButton()?.click()

    await waitFor(() => stream !== null)
    push('{"phase":"backup","message":"正在备份"}\n')
    // backup 是第 1/6 个阶段：17%。阶段名与顺序取自 PHASE_LABELS，不另抄一份。
    await waitFor(() => fillOf() === '17%')

    push('{"phase":"install"}\n')
    await waitFor(() => fillOf() === '50%')

    push('{"phase":"done","done":true}\n')
    await waitFor(() => fillOf() === '100%')
    // 流不关，consumeUpgrade 就一直等下一行，走不到「已升级」那步。
    liveStream().close()

    await waitFor(() => noticeText().includes('需手动重启'))
    // 本体这一轮结束（含预检/重启请求）后把阶段条收起来，别留个 100% 骗人。
    expect(barOf()?.hidden).toBe(true)

    closePanel()
  })

  test('未知阶段画不确定进度，不报假百分比', async () => {
    let stream: ReturnType<typeof controlledStream> | null = null
    serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () => {
        stream = controlledStream()
        return stream.response
      },
      'GET /dsh-restart/api/status': () => jsonResponse({ code: 'NOT_FOUND' }, 404),
    })

    await openPanel(document)
    upgradeButton()?.click()
    await waitFor(() => stream !== null)
    // 同一个收窄陷阱：在箭头函数里读才拿得到声明类型。
    const liveStream = (): ReturnType<typeof controlledStream> => {
      if (stream === null) throw new Error('升级请求还没发出去')
      return stream
    }
    liveStream().push('{"phase":"fetching"}\n')

    await waitFor(() => document.querySelector('.dshu-host-bar')?.hasAttribute('data-indeterminate') === true)
    expect(document.querySelector<HTMLElement>('.dshu-host-bar .dshu-bar-fill')?.style.width).toBe('')

    closePanel()
  })

  test('jsdom 式无 body 响应退回 text() 也能走完进度', async () => {
    serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () => textResponse('{"phase":"install"}\n{"phase":"done","done":true}\n'),
    })

    await openPanel(document)
    upgradeButton()?.click()

    await waitFor(() => textOf('.dshu-progress').includes('已升级到 0.2.3-alpha.2'))
    expect(textOf('.dshu-progress')).toContain('安装')
    expect(errorBar()).toBeNull()

    closePanel()
  })

  test('409 BUSY 渲染为「已有一轮升级在进行」，不是失败', async () => {
    serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () => jsonResponse({ code: 'BUSY', message: '已有一轮升级在进行，等它结束再试' }, 409),
    })

    await openPanel(document)
    upgradeButton()?.click()

    await waitFor(() => noticeText().includes('已有一轮升级在进行'))
    expect(errorBar()).toBeNull()
    expect(upgradeButton()?.disabled).toBe(false)

    closePanel()
  })

  test('失败行写红条，用服务端的中文原因，且不发重启请求', async () => {
    const calls = serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () =>
        streamResponse([
          '{"phase":"rollback","message":"正在回滚"}\n',
          '{"phase":"fail","done":true,"error":{"code":"ROLLED_BACK","message":"版本校验没过，已回滚"}}\n',
        ]),
    })

    await openPanel(document)
    upgradeButton()?.click()

    await waitFor(() => (errorBar()?.textContent ?? '').includes('版本校验没过'))
    expect(errorBar()?.textContent).toContain('已回滚')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/restart')).toHaveLength(0)

    closePanel()
  })

  test('dsh-restart 在时：升级 → 预检 → 重启，全部带各自请求头', async () => {
    const streams: { precheck: ReturnType<typeof controlledStream> | null } = { precheck: null }
    const calls = serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () => textResponse('{"phase":"done","done":true}\n'),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
      'POST /dsh-restart/api/precheck': () => {
        const stream = controlledStream()
        streams.precheck = stream
        return stream.response
      },
      'POST /dsh-restart/api/restart': () => jsonResponse({ ok: true }, 202),
    })

    await openPanel(document)
    upgradeButton()?.click()

    await waitFor(() => callsTo(calls, 'POST', '/dsh-restart/api/precheck').length === 1)
    const liveStream = (): ReturnType<typeof controlledStream> => {
      if (streams.precheck === null) throw new Error('预检请求还没发出去')
      return streams.precheck
    }
    // 阶段一次只显示一项：新阶段顶掉旧阶段，蓝色提示框里不留历史记录。
    liveStream().push('{"stage":"config","ok":true,"failures":[]}\n')
    await waitFor(() => noticeText().includes('配置检查'))
    liveStream().push('{"stage":"compat","ok":true,"failures":[]}\n')
    await waitFor(() => noticeText().includes('插件兼容检查'))
    expect(noticeText()).not.toContain('配置检查')
    liveStream().push('{"stage":"boot","ok":true,"failures":[]}\n')
    await waitFor(() => noticeText().includes('启动冒烟检查'))
    liveStream().push('{"done":true}\n')
    liveStream().close()

    await waitFor(() => callsTo(calls, 'POST', '/dsh-restart/api/restart').length === 1)
    expect(errorBar()).toBeNull()
    // 阶段提示只占那一行，进度块不再堆行。
    expect(textOf('.dshu-progress')).toBe('')
    // 重启请求发出后，面板自己关掉。
    await waitFor(() => document.querySelector('[data-dshu-panel]') === null)

    const precheck = callsTo(calls, 'POST', '/dsh-restart/api/precheck')
    expect(precheck).toHaveLength(1)
    expect(precheck[0]?.headers['x-dsh-restart']).toBe('1')
    const restart = callsTo(calls, 'POST', '/dsh-restart/api/restart')
    expect(restart).toHaveLength(1)
    expect(restart[0]?.headers['x-dsh-restart']).toBe('1')
    const statusCalls = callsTo(calls, 'GET', '/dsh-restart/api/status')
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0]?.headers['x-dsh-restart']).toBe('1')

    closePanel()
  })

  test('dsh-restart 在但 status 500：指出状态查询失败，不误报「没找到」', async () => {
    serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () => textResponse('{"phase":"done","done":true}\n'),
      'GET /dsh-restart/api/status': () => jsonResponse({ code: 'BOOM', message: '内部错误' }, 500),
    })

    await openPanel(document)
    upgradeButton()?.click()

    await waitFor(() => noticeText().includes('需手动重启'))
    expect(noticeText()).toContain('HTTP 500')
    expect(noticeText()).not.toContain('没找到')

    closePanel()
  })

  test('restart 409：提示手动刷新，不再承诺「页面会自己刷新」', async () => {
    serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () => textResponse('{"phase":"done","done":true}\n'),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true }),
      'POST /dsh-restart/api/precheck': () =>
        textResponse('{"stage":"boot","ok":true,"failures":[]}\n{"done":true}\n'),
      'POST /dsh-restart/api/restart': () => jsonResponse({ code: 'BUSY', message: '已有重启' }, 409),
    })

    await openPanel(document)
    upgradeButton()?.click()

    await waitFor(() => noticeText().includes('重启在进行'))
    expect(noticeText()).toContain('手动刷新')
    expect(noticeText()).not.toContain('自己刷新')

    closePanel()
  })

  test('升级进行中：预发布开关与重新检查都禁用，结束后恢复', async () => {
    let push: (chunk: string) => void = () => {}
    let finish: () => void = () => {}
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(encoder.encode(chunk))
        finish = () => controller.close()
      },
    })
    serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () => ({
        ok: true,
        status: 200,
        body: stream,
        json: async () => null,
        text: async () => '',
      }),
    })

    await openPanel(document)
    const toggle = document.querySelector<HTMLInputElement>('.dshu-prerelease')
    const refresh = document.querySelector<HTMLButtonElement>('.dshu-refresh')

    upgradeButton()?.click()
    expect(toggle?.disabled).toBe(true)
    expect(refresh?.disabled).toBe(true)

    push('{"phase":"done","done":true}\n')
    finish()
    await waitFor(() => toggle?.disabled === false)
    expect(refresh?.disabled).toBe(false)
    expect(noticeText()).toContain('需手动重启')

    closePanel()
  })

  test('预检没全过时不重启，并说明需手动重启', async () => {
    const calls = serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/upgrade': () => textResponse('{"phase":"done","done":true}\n'),
      'GET /dsh-restart/api/status': () => jsonResponse({ ok: true, health: true, port: 3080 }),
      'POST /dsh-restart/api/precheck': () =>
        textResponse('{"stage":"config","ok":false,"failures":[{"kind":"config","message":"配置解析失败"}]}\n{"done":true}\n'),
    })

    await openPanel(document)
    upgradeButton()?.click()

    await waitFor(() => noticeText().includes('需手动重启'))
    expect(noticeText()).toContain('预检')
    // 终止事件也带 done:true，但 ok:false 时不能写「完成」打脸下面的通知。
    expect(textOf('.dshu-progress')).not.toContain('重启预检完成')
    expect(callsTo(calls, 'POST', '/dsh-restart/api/restart')).toHaveLength(0)

    closePanel()
  })
})

describe('刷新与预发布开关', () => {
  test('预发布开关用 POST check { includePrerelease: true } 重新渲染', async () => {
    const calls = serve({
      ...fullRoutes(),
      'GET /dsh-upgrade/api/status': () =>
        jsonResponse({ ...SURVEY_UPDATE, target: '0.2.2-rc.5' }),
      'POST /dsh-upgrade/api/check': () => jsonResponse({ ...SURVEY_UPDATE, includePrerelease: true }),
      'GET /dsh-upgrade/api/releases': () => jsonResponse({ releases: [], degraded: false }),
    })

    await openPanel(document)
    expect(hostSection()?.textContent).toContain('已是最新')

    const toggle = document.querySelector<HTMLInputElement>('.dshu-prerelease')
    expect(toggle).not.toBeNull()
    if (toggle !== null) {
      toggle.checked = true
      toggle.dispatchEvent(new Event('change', { bubbles: true }))
    }

    await waitFor(() => (hostSection()?.textContent ?? '').includes('0.2.3-alpha.2'))
    const checks = callsTo(calls, 'POST', '/dsh-upgrade/api/check')
    expect(checks).toHaveLength(1)
    expect(checks[0]?.headers['x-dsh-upgrade']).toBe('1')
    expect(checks[0]?.body).toEqual({ includePrerelease: true, force: false })

    closePanel()
  })

  test('刷新按钮用 POST check { force: true } 重新拉', async () => {
    const calls = serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/check': () => jsonResponse(SURVEY_UPDATE),
    })

    await openPanel(document)
    document.querySelector<HTMLButtonElement>('.dshu-refresh')?.click()

    await waitFor(() => callsTo(calls, 'POST', '/dsh-upgrade/api/check').length === 1)
    const checks = callsTo(calls, 'POST', '/dsh-upgrade/api/check')
    expect(checks[0]?.body).toEqual({ includePrerelease: false, force: true })

    closePanel()
  })

  test('装完没重启后点「重新检查」：仍是「需重启」，角标不灭', async () => {
    const survey = { ...SURVEY_UPDATE, target: SURVEY_UPDATE.current, restartRequired: true }
    const calls = serve({
      ...fullRoutes(),
      'GET /dsh-upgrade/api/status': () => jsonResponse(survey),
      'POST /dsh-upgrade/api/check': () => jsonResponse(survey),
    })
    const states: Array<{ hasUpdate: boolean }> = []

    await openPanel(document, { onState: (state) => states.push({ hasUpdate: state.hasUpdate }) })
    document.querySelector<HTMLButtonElement>('.dshu-refresh')?.click()

    await waitFor(() => callsTo(calls, 'POST', '/dsh-upgrade/api/check').length === 1)
    await waitFor(() => states.length >= 2)
    const text = hostSection()?.textContent ?? ''
    expect(text).toContain('需重启')
    expect(text).not.toContain('已是最新')
    expect(states.at(-1)?.hasUpdate).toBe(true)
    expect(upgradeButton()).toBeNull()

    closePanel()
  })

  test('刷新失败保留上一份状态，刷新成功清掉红条', async () => {
    let checks = 0
    const calls = serve({
      ...fullRoutes(),
      'POST /dsh-upgrade/api/check': () => {
        checks += 1
        if (checks === 1) return jsonResponse({ code: 'INTERNAL', message: '读取失败' }, 500)
        return jsonResponse(SURVEY_UPDATE)
      },
    })

    await openPanel(document)
    expect(hostSection()?.textContent).toContain('0.2.3-alpha.2')

    document.querySelector<HTMLButtonElement>('.dshu-refresh')?.click()
    await waitFor(() => errorBar() !== null)
    // 一次抖动不该把升级按钮和版本信息抹掉。
    expect(hostSection()?.textContent).toContain('0.2.3-alpha.2')
    expect(upgradeButton()).not.toBeNull()

    document.querySelector<HTMLButtonElement>('.dshu-refresh')?.click()
    await waitFor(() => errorBar() === null)
    expect(hostSection()?.textContent).toContain('0.2.3-alpha.2')
    expect(callsTo(calls, 'POST', '/dsh-upgrade/api/check')).toHaveLength(2)

    closePanel()
  })
})

describe('遮罩、关闭与幂等', () => {
  test('连开两次只有一个遮罩；关闭后从页面移除并还原滚动锁', async () => {
    serve(fullRoutes())
    document.body.style.overflow = 'scroll'

    await openPanel(document)
    await openPanel(document)

    expect(document.querySelectorAll('.dshu-panel')).toHaveLength(1)
    expect(document.querySelectorAll('.dshu-overlay')).toHaveLength(1)
    expect(document.body.style.overflow).toBe('hidden')

    document.querySelector<HTMLButtonElement>('.dshu-close')?.click()

    expect(document.querySelector('.dshu-overlay')).toBeNull()
    expect(document.body.style.overflow).toBe('scroll')

    // 关掉后还能再开。
    await openPanel(document)
    expect(document.querySelectorAll('.dshu-panel')).toHaveLength(1)
    closePanel()
  })

  test('Escape 关闭面板', async () => {
    serve(fullRoutes())
    await openPanel(document)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.dshu-overlay')).toBeNull()
  })

  test('关闭时调用 onClose 一次', async () => {
    serve(fullRoutes())
    const onClose = vi.fn()
    await openPanel(document, { onClose })

    document.querySelector<HTMLButtonElement>('.dshu-close')?.click()

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('apply 入口', () => {
  function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  test('先挂入口再拉状态；有更新才点角标（不抢在座位前设置状态）', async () => {
    document.body.innerHTML = '<div data-slot="sidebar.footer.action"></div>'
    const gate = deferred<FakeResponse>()
    vi.stubGlobal('fetch', async (input: unknown) => {
      const path = pathOf(String(input))
      if (path === '/dsh-upgrade/api/status') return (await gate.promise) as unknown as Response
      if (path === '/dsh-market/api/v1/updates/summary') {
        return jsonResponse({ schema: 1, checked: 0, packages: [] }) as unknown as Response
      }
      return jsonResponse({}, 404) as unknown as Response
    })

    const cleanups: Array<() => void> = []
    // 跟 cordis 的 Fiber.effect 一样：立刻执行传入函数，把返回值当 disposer。
    apply({
      effect: (fn) => {
        const disposer = fn() as unknown
        if (typeof disposer === 'function') cleanups.push(disposer as unknown as () => void)
      },
    })

    // 状态还没回来，入口已经在了：这就是 mount → fetch → setEntryState 的顺序。
    const entry = document.querySelector('[data-dshu-entry]')
    expect(entry).not.toBeNull()
    expect(entry?.getAttribute('data-has-update')).toBeNull()

    gate.resolve(jsonResponse(SURVEY_UPDATE))
    await waitFor(() => document.querySelector('[data-dshu-entry]')?.getAttribute('data-has-update') === '1')

    while (cleanups.length > 0) cleanups.pop()?.()
  })

  test('只有插件有更新也会点角标', async () => {
    document.body.innerHTML = '<div data-slot="sidebar.footer.action"></div>'
    vi.stubGlobal('fetch', async (input: unknown) => {
      const path = pathOf(String(input))
      if (path === '/dsh-upgrade/api/status') {
        return jsonResponse({ ...SURVEY_UPDATE, target: '0.2.2-rc.5' }) as unknown as Response
      }
      if (path === '/dsh-market/api/v1/updates/summary') return jsonResponse(MARKET) as unknown as Response
      return jsonResponse({}, 404) as unknown as Response
    })

    const cleanups: Array<() => void> = []
    // 跟 cordis 的 Fiber.effect 一样：立刻执行传入函数，把返回值当 disposer。
    apply({
      effect: (fn) => {
        const disposer = fn() as unknown
        if (typeof disposer === 'function') cleanups.push(disposer as unknown as () => void)
      },
    })

    await waitFor(() => document.querySelector('[data-dshu-entry]')?.getAttribute('data-has-update') === '1')
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  test('两处都没有更新时不点角标', async () => {
    document.body.innerHTML = '<div data-slot="sidebar.footer.action"></div>'
    vi.stubGlobal('fetch', async (input: unknown) => {
      const path = pathOf(String(input))
      if (path === '/dsh-upgrade/api/status') {
        return jsonResponse({ ...SURVEY_UPDATE, target: '0.2.2-rc.5' }) as unknown as Response
      }
      if (path === '/dsh-market/api/v1/updates/summary') {
        return jsonResponse({ schema: 1, checked: 3, packages: [] }) as unknown as Response
      }
      return jsonResponse({}, 404) as unknown as Response
    })

    const cleanups: Array<() => void> = []
    // 跟 cordis 的 Fiber.effect 一样：立刻执行传入函数，把返回值当 disposer。
    apply({
      effect: (fn) => {
        const disposer = fn() as unknown
        if (typeof disposer === 'function') cleanups.push(disposer as unknown as () => void)
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(document.querySelector('[data-dshu-entry]')?.getAttribute('data-has-update')).toBeNull()
    while (cleanups.length > 0) cleanups.pop()?.()
  })
})
