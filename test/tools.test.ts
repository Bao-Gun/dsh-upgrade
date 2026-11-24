/**
 * Task 9：两个 agent 工具与插件入口。
 *
 * 会碰真实安装目录 / 网络 / 子进程的依赖全部注入，测试不联网、不装任何东西；
 * DSH_UPGRADE_ROOT 指到临时目录，不读写真实的升级状态文件。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { apply, inject as pluginInject, name as pluginName } from '../src/index'
import type { RegistryInfo } from '../src/server/host'
import { releaseUpgrade, tryAcquireUpgrade } from '../src/server/lock'
import {
  CHECK_PATH,
  PLUGIN_VERSION_PATH,
  RELEASES_PATH,
  STATUS_PATH,
  UPGRADE_PATH,
} from '../src/server/routes'
import { readLast, readRestartRequired } from '../src/server/state'
import { dshUpgrade, dshUpgradeCheck, registerTools, type ToolDeps } from '../src/server/tools'
import type { UpgradeEvent } from '../src/server/upgrade'

const CURRENT = '0.2.2-rc.5'
const ALPHA = '0.2.3-alpha.2'
const OLD = '0.2.1'
const HOST_DIR = '/opt/example/dsh-install'
const NODE = '26.7.0'
const ALPHA_ENGINES = '^24.22.3 || >=26.13.1'

/** 注册上来的工具只按结构用，测试不 import 宿主的类型。 */
type RegisteredTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: string; text: string }>
  }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

type UpgradeInput = { target: string; installDir: string; root: string }

let upgradeRoot = ''

beforeEach(async () => {
  upgradeRoot = await mkdtemp(join(tmpdir(), 'dsh-upgrade-tools-'))
  process.env.DSH_UPGRADE_ROOT = upgradeRoot
})

afterEach(async () => {
  delete process.env.DSH_UPGRADE_ROOT
  await rm(upgradeRoot, { recursive: true, force: true })
})

function registryInfo(): RegistryInfo {
  return {
    versions: [OLD, CURRENT, ALPHA],
    channels: { latest: OLD, next: CURRENT, alpha: ALPHA },
    publishedAt: {
      [OLD]: '2026-11-01T00:00:00.000Z',
      [CURRENT]: '2026-11-10T00:00:00.000Z',
      [ALPHA]: '2026-11-20T00:00:00.000Z',
    },
  }
}

/** 默认假依赖：当前 0.2.2-rc.5，alpha 要求 Node ^24.22.3 || >=26.13.1，本机 26.7.0。 */
function fakeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    readHostInfo: vi.fn(async () => ({ dir: HOST_DIR, version: CURRENT })),
    fetchRegistry: vi.fn(async () => ({ info: registryInfo(), cached: true })),
    readTargetManifest: vi.fn(async (version: string) =>
      version === ALPHA ? { engines: { node: ALPHA_ENGINES } } : {},
    ),
    runUpgrade: vi.fn(async (_input: UpgradeInput, emit: (event: UpgradeEvent) => void) => {
      emit({ phase: 'done', message: '升级完成', done: true })
      return { ok: true }
    }),
    nodeVersion: () => NODE,
    ...overrides,
  }
}

function fakeToolsCtx(): {
  ctx: { effect(callback: () => void | (() => void), label?: string): void; get(name: string): unknown }
  registered: RegisteredTool[]
  disposers: Array<() => void>
} {
  const registered: RegisteredTool[] = []
  const disposers: Array<() => void> = []
  return {
    registered,
    disposers,
    ctx: {
      effect(callback) {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      get(name) {
        if (name !== 'tools') return undefined
        return {
          register(definition: RegisteredTool): () => void {
            registered.push(definition)
            return () => {
              registered.splice(registered.indexOf(definition), 1)
            }
          },
        }
      },
    },
  }
}

describe('dshUpgradeCheck', () => {
  test('稳定通道没有新版就留在当前版本，并把 alpha 被 Node 版本拦住这件事报出来', async () => {
    const value = await dshUpgradeCheck({}, fakeDeps())

    expect(value).toEqual({
      current: CURRENT,
      channels: { latest: OLD, next: CURRENT, alpha: ALPHA },
      target: CURRENT,
      blocked: { code: 'RUNTIME_UNSUPPORTED', message: expect.stringContaining(NODE) },
    })
  })

  test('includePrerelease 时目标就是被拦的 alpha，blocked 仍跟着它', async () => {
    const value = await dshUpgradeCheck({ includePrerelease: true }, fakeDeps())

    expect(value.target).toBe(ALPHA)
    expect(value.blocked?.code).toBe('RUNTIME_UNSUPPORTED')
  })

  test('Node 满足要求时不带 blocked 字段', async () => {
    const deps = fakeDeps({ nodeVersion: () => '26.13.1' })
    const value = await dshUpgradeCheck({ includePrerelease: true }, deps)

    expect(value.target).toBe(ALPHA)
    expect('blocked' in value).toBe(false)
  })
})

describe('dshUpgrade', () => {
  test('目标被 Node 版本拦住时直接拒绝，且不调安装', async () => {
    const deps = fakeDeps()
    const value = await dshUpgrade({ target: ALPHA }, deps)

    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('RUNTIME_UNSUPPORTED')
    expect(vi.mocked(deps.readTargetManifest!)).toHaveBeenCalledWith(ALPHA)
    expect(vi.mocked(deps.runUpgrade!)).not.toHaveBeenCalled()
    // 被拦的版本不能留下任何「已升级」的盘上痕迹。
    expect(await readLast()).toBeNull()
  })

  test('装得上的版本：调安装并提醒重启', async () => {
    const deps = fakeDeps()
    const value = await dshUpgrade({ target: OLD }, deps)

    expect(value).toEqual({ ok: true, to: OLD, restartRequired: true })
    const run = vi.mocked(deps.runUpgrade!)
    expect(run).toHaveBeenCalledTimes(1)
    const input = run.mock.calls[0]?.[0]
    expect(input).toMatchObject({ target: OLD, installDir: HOST_DIR })
    expect(input?.root).toBe(upgradeRoot)

    // agent 升级也要给页面留「装完没重启」的凭据，刷新后仍能提示需重启。
    expect(await readRestartRequired(OLD)).toBe(true)
    const last = JSON.parse(await readFile(join(upgradeRoot, 'last.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(last.lastResult).toMatchObject({ to: OLD, restartRequired: true })
    expect('lastError' in last).toBe(false)
  })

  test('registry 里没有的版本直接拒绝', async () => {
    const deps = fakeDeps()
    const value = await dshUpgrade({ target: '9.9.9' }, deps)

    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('INVALID_TARGET')
    expect(vi.mocked(deps.runUpgrade!)).not.toHaveBeenCalled()
  })

  test('空目标直接拒绝', async () => {
    const value = await dshUpgrade({ target: '   ' }, fakeDeps())

    expect(value.ok).toBe(false)
    expect(value.error?.code).toBe('INVALID_TARGET')
  })

  test('安装失败时把状态机的错误原样带回，不抛', async () => {
    const deps = fakeDeps({
      runUpgrade: vi.fn(async () => ({ ok: false, error: { code: 'INSTALL_FAILED', message: '装不上' } })),
    })
    const value = await dshUpgrade({ target: OLD }, deps)

    expect(value).toEqual({ ok: false, error: { code: 'INSTALL_FAILED', message: '装不上' } })
  })

  test('读不到宿主安装也返回带码的错误，不抛', async () => {
    const deps = fakeDeps({
      readHostInfo: vi.fn(async () => {
        throw Object.assign(new Error('找不到 DSH 安装目录'), { code: 'HOST_NOT_FOUND' })
      }),
    })
    const value = await dshUpgrade({ target: OLD }, deps)

    expect(value.ok).toBe(false)
    expect(value.error).toEqual({ code: 'HOST_NOT_FOUND', message: '找不到 DSH 安装目录' })
    expect(vi.mocked(deps.runUpgrade!)).not.toHaveBeenCalled()
  })

  test('页面正在升级时抢不到锁：直接 BUSY，不并发装第二遍（R24）', async () => {
    const deps = fakeDeps()
    // 模拟 HTTP 端 /upgrade 已经在跑：锁被同一个 helper 占住。
    expect(tryAcquireUpgrade()).toBe(true)
    try {
      const value = await dshUpgrade({ target: OLD }, deps)

      expect(value).toEqual({ ok: false, error: { code: 'BUSY', message: '已有升级在进行中' } })
      expect(vi.mocked(deps.runUpgrade!)).not.toHaveBeenCalled()
    } finally {
      releaseUpgrade()
    }
    // 锁放开后还能升级：失败路径没有把锁永久占住。
    const after = await dshUpgrade({ target: OLD }, fakeDeps())
    expect(after.ok).toBe(true)
  })
})

/** 让 apply 里 fire-and-forget 的补通知在临时 DSH_UPGRADE_ROOT 还有效时跑完。 */
async function flushSettle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

describe('registerTools', () => {
  test('两个工具都注册，参数与输出都是宿主认得的 JSON Schema', () => {
    const { ctx, registered } = fakeToolsCtx()

    expect(registerTools(ctx, fakeDeps())).toBe(2)
    expect(registered.map((item) => item.name)).toEqual(['dsh_upgrade_check', 'dsh_upgrade'])

    for (const definition of registered) {
      expect(definition.description).not.toBe('')
      expect(definition.parameters).toMatchObject({ type: 'object' })
      expect(definition.output.schema).toMatchObject({ type: 'object' })
      // 只允许 JSON 值：函数 / undefined 过不去这一轮
      expect(JSON.parse(JSON.stringify(definition.parameters))).toEqual(definition.parameters)
      expect(JSON.parse(JSON.stringify(definition.output.schema))).toEqual(definition.output.schema)
      expect(typeof definition.output.render).toBe('function')
      expect(typeof definition.execute).toBe('function')
    }

    const [check, upgrade] = registered
    expect(check?.parameters).toMatchObject({
      type: 'object',
      properties: { includePrerelease: { type: 'boolean' } },
    })
    expect(upgrade?.parameters).toMatchObject({
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    })
    // 升级工具不负责重启，描述里必须把这件事指向 dsh_restart
    expect(upgrade?.description).toContain('dsh_restart')
  })

  test('注册的 execute / render 直接可用，走的是同一套注入依赖', async () => {
    const { ctx, registered } = fakeToolsCtx()
    registerTools(ctx, fakeDeps())

    const check = registered[0]
    expect(check).toBeDefined()
    const value = (await check!.execute({ includePrerelease: true }, {})) as { target?: string }
    expect(value.target).toBe(ALPHA)

    const rendered = check!.output.render({}, value)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]?.text).toContain(ALPHA)

    const upgrade = registered[1]
    const upgraded = (await upgrade!.execute({ target: OLD }, {})) as { ok?: boolean }
    expect(upgraded.ok).toBe(true)
    const upgradeText = upgrade!.output.render({ target: OLD }, upgraded)
    expect(upgradeText[0]?.text).toContain('dsh_restart')
  })

  test('宿主没有 tools 服务：警告一次、什么都不注册、不抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      expect(registerTools({}, fakeDeps())).toBe(0)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  test('畸形 ctx：没有 effect 也能注册，不抛', () => {
    const registered: RegisteredTool[] = []
    const ctx = {
      get: () => ({
        register(definition: RegisteredTool): () => void {
          registered.push(definition)
          return () => {}
        },
      }),
    }

    expect(registerTools(ctx, fakeDeps())).toBe(2)
    expect(registered.map((item) => item.name)).toEqual(['dsh_upgrade_check', 'dsh_upgrade'])
  })
})

describe('插件入口', () => {
  test('名字与注入声明', () => {
    expect(pluginName).toBe('dsh-upgrade')
    expect(pluginInject).toEqual(['webServer'])
  })

  test('有 webServer 时五条路由都挂上', async () => {
    const paths: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = {
      effect(callback: () => void | (() => void)): void {
        callback()
      },
      webServer: {
        register(route: { path: string }): () => void {
          paths.push(route.path)
          return () => {}
        },
      },
    }

    try {
      expect(() => apply(ctx as unknown as Parameters<typeof apply>[0])).not.toThrow()
      expect(paths).toEqual([
        STATUS_PATH,
        CHECK_PATH,
        RELEASES_PATH,
        UPGRADE_PATH,
        PLUGIN_VERSION_PATH,
      ])
      await flushSettle()
    } finally {
      warn.mockRestore()
    }
  })

  test('路由注册炸了也不影响工具注册，apply 不抛', async () => {
    const { ctx, registered } = fakeToolsCtx()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      // 没有 webServer 也没有 route：路由那一步会抛
      expect(() => apply(ctx as unknown as Parameters<typeof apply>[0])).not.toThrow()
      expect(registered.map((item) => item.name)).toEqual(['dsh_upgrade_check', 'dsh_upgrade'])
      expect(warn.mock.calls.some(([first]) => String(first).includes('路由'))).toBe(true)
      await flushSettle()
    } finally {
      warn.mockRestore()
    }
  })

  test('畸形 ctx（什么都没有）不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      expect(() => apply({} as unknown as Parameters<typeof apply>[0])).not.toThrow()
      await flushSettle()
    } finally {
      warn.mockRestore()
    }
  })
})
