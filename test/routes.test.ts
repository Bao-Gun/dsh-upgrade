import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runUpgrade, type UpgradeEvent } from '../src/server/upgrade'
import type { RegistryInfo } from '../src/server/host'
import {
  CHECK_PATH,
  RELEASES_PATH,
  STATUS_PATH,
  UPGRADE_PATH,
  registerUpgradeRoutes,
  type RouteDeps,
  type RouteHandler,
  type RouteRequest,
  type RouteResponse,
} from '../src/server/routes'
import { writeLast } from '../src/server/state'

const CURRENT = '0.2.2-rc.5'
const TARGET = '0.2.3-alpha.2'
const NOW = 1_700_000_000_000
/** 故意做成一眼能认出的内部路径：403 的 body 里出现它就是泄露 */
const INSTALL_DIR = '/opt/secret/dsh-install'

type UpgradeInput = Parameters<typeof runUpgrade>[0]
type UpgradeEmit = (event: UpgradeEvent) => void

let root: string
const originalRoot = process.env.DSH_UPGRADE_ROOT

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-upgrade-routes-'))
  process.env.DSH_UPGRADE_ROOT = root
})

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.DSH_UPGRADE_ROOT
  else process.env.DSH_UPGRADE_ROOT = originalRoot
  await rm(root, { recursive: true, force: true })
})

function registryInfo(overrides: Partial<RegistryInfo> = {}): RegistryInfo {
  return {
    versions: [CURRENT, TARGET, '0.2.1'],
    channels: { latest: '0.2.1', next: CURRENT, alpha: TARGET },
    publishedAt: {
      [CURRENT]: '2026-11-18T00:00:00Z',
      [TARGET]: '2026-11-22T00:00:00Z',
    },
    ...overrides,
  }
}

function baseDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  return {
    readHostInfo: vi.fn(async () => ({ dir: INSTALL_DIR, version: CURRENT })),
    fetchRegistry: vi.fn(async () => ({ info: registryInfo(), cached: true })),
    readTargetManifest: vi.fn(async () => ({ engines: { node: '^24.22.3 || >=26.13.1' } })),
    fetchReleases: vi.fn(async () => ({ releases: [], degraded: true })),
    runUpgrade: vi.fn(async (_input: UpgradeInput, emit: UpgradeEmit) => {
      emit({ phase: 'precheck', message: '检查 Node 版本与磁盘可用空间' })
      emit({ phase: 'done', message: '已升级，需重启生效', done: true })
      return { ok: true }
    }) as unknown as typeof runUpgrade,
    nodeVersion: () => '26.7.0',
    now: () => NOW,
    ...overrides,
  }
}

type Registered = { method: string; path: string; handler: RouteHandler }

const METHOD_OF: Record<string, string> = {
  [STATUS_PATH]: 'GET',
  [CHECK_PATH]: 'POST',
  [RELEASES_PATH]: 'GET',
  [UPGRADE_PATH]: 'POST',
}

/** 假 ctx：照真实宿主接线（effect + webServer.register）收集路由表 */
function setup(deps: RouteDeps): (path: string) => Registered {
  const routes: Registered[] = []
  const ctx = {
    effect(callback: () => void | (() => void)): void {
      callback()
    },
    webServer: {
      register(route: { kind: 'exact'; path: string; handler: RouteHandler }): () => void {
        routes.push({ method: METHOD_OF[route.path] ?? '', path: route.path, handler: route.handler })
        return () => {}
      },
    },
  }
  registerUpgradeRoutes(ctx, deps)
  return (path: string) => {
    const found = routes.find((route) => route.path === path)
    if (found === undefined) throw new Error('未注册路由：' + path)
    return found
  }
}

type FakeResponse = {
  res: RouteResponse
  state: {
    status: number
    headers: Record<string, string>
    chunks: string[]
    ended: boolean
    body: string
  }
}

function fakeRes(): FakeResponse {
  const state: FakeResponse['state'] = {
    status: 0,
    headers: {},
    chunks: [],
    ended: false,
    body: '',
  }
  const res: RouteResponse = {
    status(code) {
      state.status = code
      return res
    },
    header(key, value) {
      state.headers[key.toLowerCase()] = value
      return res
    },
    write(chunk) {
      state.chunks.push(chunk)
    },
    end(body) {
      if (body !== undefined) state.chunks.push(body)
      state.ended = true
      state.body = state.chunks.join('')
    },
  }
  return { res, state }
}

function request(
  method: string,
  url: string,
  options: {
    body?: unknown
    origin?: string
    host?: string
    guard?: boolean
  } = {},
): RouteRequest {
  const headers: Record<string, string | undefined> = { host: options.host ?? '127.0.0.1:3080' }
  if (options.guard !== false) headers['x-dsh-upgrade'] = '1'
  if (options.origin !== undefined) headers.origin = options.origin
  return options.body === undefined
    ? { method, headers, url }
    : { method, headers, url, body: options.body }
}

function jsonOf(state: FakeResponse['state']): Record<string, unknown> {
  return JSON.parse(state.body) as Record<string, unknown>
}

describe('请求门', () => {
  test('缺 x-dsh-upgrade: 1 → 403，且 body 不含内部路径', async () => {
    const deps = baseDeps()
    const route = setup(deps)(STATUS_PATH)
    const { res, state } = fakeRes()

    await route.handler(request('GET', STATUS_PATH, { guard: false }), res)

    expect(state.status).toBe(403)
    expect(jsonOf(state).code).toBe('FORBIDDEN')
    expect(state.body).not.toContain('secret')
    expect(state.body).not.toContain(INSTALL_DIR)
    // 请求门挡在业务之前：连宿主目录都不该去读
    expect(deps.readHostInfo).not.toHaveBeenCalled()
  })

  test('Origin 与 Host 不一致 → 403；一致则放行', async () => {
    const route = setup(baseDeps())(STATUS_PATH)

    const mismatched = fakeRes()
    await route.handler(
      request('GET', STATUS_PATH, { origin: 'https://evil.example', host: '127.0.0.1:3080' }),
      mismatched.res,
    )
    expect(mismatched.state.status).toBe(403)

    const matched = fakeRes()
    await route.handler(
      request('GET', STATUS_PATH, { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }),
      matched.res,
    )
    expect(matched.state.status).toBe(200)
  })

  test('方法不对 → 403', async () => {
    const route = setup(baseDeps())(STATUS_PATH)
    const { res, state } = fakeRes()

    await route.handler(request('POST', STATUS_PATH), res)

    expect(state.status).toBe(403)
    expect(jsonOf(state).code).toBe('METHOD_NOT_ALLOWED')
  })
})

describe('GET /status', () => {
  test('200，含 current / channels / target / blocked / includePrerelease', async () => {
    const deps = baseDeps()
    const route = setup(deps)(STATUS_PATH)
    const { res, state } = fakeRes()

    await route.handler(request('GET', STATUS_PATH), res)

    expect(state.status).toBe(200)
    expect(state.headers['content-type']).toContain('application/json')
    const body = jsonOf(state)
    expect(body.current).toBe(CURRENT)
    expect(body.channels).toEqual({ latest: '0.2.1', next: CURRENT, alpha: TARGET })
    // 稳定通道没有比当前 rc 更新的版本 → 目标留在当前版本
    expect(body.target).toBe(CURRENT)
    expect(body.includePrerelease).toBe(false)
    // 没升级过、没标记：正常状态就是不需要重启
    expect(body.restartRequired).toBe(false)
    // 比当前新的只有 alpha，而它的 engines 不满足本机 node → 报被拦原因
    expect(body.blocked).toEqual({
      code: 'RUNTIME_UNSUPPORTED',
      message: '需要 Node ^24.22.3 || >=26.13.1，本机 26.7.0',
    })
  })

  test('通道缺失时显式给 null，不是省略', async () => {
    const deps = baseDeps({
      fetchRegistry: vi.fn(async () => ({
        info: registryInfo({ channels: { latest: '0.2.1' } }),
        cached: true,
      })),
    })
    const route = setup(deps)(STATUS_PATH)
    const { res, state } = fakeRes()

    await route.handler(request('GET', STATUS_PATH), res)

    const channels = jsonOf(state).channels as Record<string, unknown>
    expect(channels).toEqual({ latest: '0.2.1', next: null, alpha: null })
  })

  test('盘上已装好当前版本、只差重启时，status 报 restartRequired true', async () => {
    // 场景：升级成功 → 页面刷新，磁盘 package.json 已是 CURRENT，进程还是旧的。
    await writeLast({ lastResult: { to: CURRENT, at: NOW, restartRequired: true } })
    const route = setup(baseDeps())(STATUS_PATH)
    const { res, state } = fakeRes()

    await route.handler(request('GET', STATUS_PATH), res)

    expect(state.status).toBe(200)
    const body = jsonOf(state)
    expect(body.target).toBe(CURRENT)
    expect(body.restartRequired).toBe(true)
  })

  test('标记指向别的版本时不算「需重启」', async () => {
    await writeLast({ lastResult: { to: TARGET, at: NOW, restartRequired: true } })
    const route = setup(baseDeps())(STATUS_PATH)
    const { res, state } = fakeRes()

    await route.handler(request('GET', STATUS_PATH), res)

    expect(jsonOf(state).restartRequired).toBe(false)
  })
})

describe('POST /check', () => {
  test('includePrerelease 时目标取预发布版，且仍带 blocked', async () => {
    const route = setup(baseDeps())(CHECK_PATH)
    const { res, state } = fakeRes()

    await route.handler(request('POST', CHECK_PATH, { body: { includePrerelease: true } }), res)

    expect(state.status).toBe(200)
    const body = jsonOf(state)
    expect(body.includePrerelease).toBe(true)
    expect(body.target).toBe(TARGET)
    expect((body.blocked as Record<string, unknown>).code).toBe('RUNTIME_UNSUPPORTED')
    const candidates = body.candidates as Array<Record<string, unknown>>
    expect(candidates.map((candidate) => candidate.version)).toContain(TARGET)
  })
})

describe('POST /upgrade', () => {
  test('成功：多行 NDJSON，最后一行 done: true；写 pending 与 last', async () => {
    const runUpgradeMock = vi.fn(async (_input: UpgradeInput, emit: UpgradeEmit) => {
      emit({ phase: 'precheck', message: '检查 Node 版本与磁盘可用空间' })
      emit({ phase: 'done', message: '已升级，需重启生效', done: true })
      return { ok: true }
    })
    const deps = baseDeps({ runUpgrade: runUpgradeMock as unknown as typeof runUpgrade })
    const route = setup(deps)(UPGRADE_PATH)
    const { res, state } = fakeRes()

    await route.handler(request('POST', UPGRADE_PATH, { body: { target: TARGET } }), res)

    expect(state.status).toBe(200)
    expect(state.headers['content-type']).toContain('ndjson')
    const lines = state.chunks
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk !== '')
      .map((chunk) => JSON.parse(chunk) as Record<string, unknown>)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines.at(-1)?.done).toBe(true)

    expect(runUpgradeMock).toHaveBeenCalledTimes(1)
    expect(runUpgradeMock.mock.calls[0]?.[0]).toMatchObject({
      target: TARGET,
      installDir: INSTALL_DIR,
      root,
    })

    const pending = JSON.parse(await readFile(join(root, 'pending.json'), 'utf8')) as {
      from: string
      to: string
    }
    expect(pending.from).toBe(CURRENT)
    expect(pending.to).toBe(TARGET)

    const last = JSON.parse(await readFile(join(root, 'last.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(last.running).toBe(false)
    expect((last.lastResult as Record<string, unknown>).to).toBe(TARGET)
    expect((last.lastResult as Record<string, unknown>).restartRequired).toBe(true)
    // R10：成功路径显式传 lastError: undefined，旧错误必须被删掉
    expect('lastError' in last).toBe(false)
  })

  test('BUSY：第一个请求未结束时第二个 409，升级只跑一次，不覆盖 pending', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const runUpgradeMock = vi.fn(async (_input: UpgradeInput, emit: UpgradeEmit) => {
      calls += 1
      await gate
      emit({ phase: 'done', message: '已升级，需重启生效', done: true })
      return { ok: true }
    })
    const deps = baseDeps({ runUpgrade: runUpgradeMock as unknown as typeof runUpgrade })
    const route = setup(deps)(UPGRADE_PATH)

    const first = fakeRes()
    const firstCall = route.handler(
      request('POST', UPGRADE_PATH, { body: { target: TARGET } }),
      first.res,
    )
    await vi.waitFor(() => {
      expect(runUpgradeMock).toHaveBeenCalledTimes(1)
    })

    const second = fakeRes()
    await route.handler(
      request('POST', UPGRADE_PATH, { body: { target: '0.2.9' } }),
      second.res,
    )
    expect(second.state.status).toBe(409)
    expect(jsonOf(second.state).code).toBe('BUSY')

    release()
    await firstCall
    expect(runUpgradeMock).toHaveBeenCalledTimes(1)
    const lastLine = JSON.parse(
      first.state.chunks.at(-1)?.trim() ?? '{}',
    ) as Record<string, unknown>
    expect(lastLine.done).toBe(true)

    const pending = JSON.parse(await readFile(join(root, 'pending.json'), 'utf8')) as {
      to: string
    }
    expect(pending.to).toBe(TARGET)
  })

  test('升级抛错也释放单飞锁', async () => {
    let calls = 0
    const runUpgradeMock = vi.fn(async (_input: UpgradeInput, emit: UpgradeEmit) => {
      calls += 1
      if (calls === 1) throw new Error('npm 挂了')
      emit({ phase: 'done', message: '已升级，需重启生效', done: true })
      return { ok: true }
    })
    const deps = baseDeps({ runUpgrade: runUpgradeMock as unknown as typeof runUpgrade })
    const route = setup(deps)(UPGRADE_PATH)

    const first = fakeRes()
    await route.handler(
      request('POST', UPGRADE_PATH, { body: { target: TARGET } }),
      first.res,
    )
    const failure = JSON.parse(first.state.chunks.at(-1)?.trim() ?? '{}') as Record<
      string,
      unknown
    >
    expect(failure.phase).toBe('fail')
    expect(failure.done).toBe(true)
    expect((failure.error as Record<string, unknown>).code).toBe('UPGRADE_FAILED')

    // 锁没被永久占住：第二次不再 409
    const second = fakeRes()
    await route.handler(
      request('POST', UPGRADE_PATH, { body: { target: TARGET } }),
      second.res,
    )
    expect(second.state.status).toBe(200)
    expect(runUpgradeMock).toHaveBeenCalledTimes(2)
  })
})

describe('GET /releases', () => {
  test('降级时 200 + degraded: true，不是 500', async () => {
    const deps = baseDeps({
      fetchReleases: vi.fn(async () => ({ releases: [], degraded: true })),
    })
    const route = setup(deps)(RELEASES_PATH)
    const { res, state } = fakeRes()

    await route.handler(
      request('GET', RELEASES_PATH + '?from=' + CURRENT + '&to=' + TARGET),
      res,
    )

    expect(state.status).toBe(200)
    const body = jsonOf(state)
    expect(body.degraded).toBe(true)
    expect(body.releases).toEqual([])
  })

  test('缺 from/to → 400', async () => {
    const route = setup(baseDeps())(RELEASES_PATH)
    const { res, state } = fakeRes()

    await route.handler(request('GET', RELEASES_PATH), res)

    expect(state.status).toBe(400)
    expect(jsonOf(state).code).toBe('INVALID_RANGE')
  })
})
