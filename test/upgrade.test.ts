import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runUpgrade, type UpgradeEvent } from '../src/server/upgrade'
import { backupDir } from '../src/server/state'

const TARGET = '0.2.3-alpha.2'
const CURRENT = '0.2.2-rc.5'
const MIB = 1024 * 1024
const NPM_TIMEOUT_MS = 15 * 60 * 1000

type Fixture = {
  statfs: Mock
  cloneDir: Mock
  removeDir: Mock
  moveDir: Mock
  runNpmInstall: Mock
  readInstalledVersion: Mock
  runVersionProbe: Mock
  readTargetEngines: Mock
  nodeVersion: Mock
}

let prefix: string
let installDir: string
let root: string
let events: UpgradeEvent[]

beforeEach(async () => {
  // 安装目录必须落在 <prefix>/lib/node_modules/@deepseek-ai/dsh 上，前缀才能推出来
  prefix = await mkdtemp(join(tmpdir(), 'dsh-upgrade-prefix-'))
  installDir = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  root = await mkdtemp(join(tmpdir(), 'dsh-upgrade-root-'))
  events = []
})

afterEach(async () => {
  await rm(prefix, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
})

/** 全部依赖注入：任何默认 dep 在测试里跑起来都算越界。 */
function baseDeps(): Fixture {
  return {
    statfs: vi.fn(async () => ({ bavail: 113 * 1024 * MIB, bsize: 1 })),
    cloneDir: vi.fn(async () => undefined),
    removeDir: vi.fn(async () => undefined),
    moveDir: vi.fn(async () => undefined),
    runNpmInstall: vi.fn(async () => ({ code: 0, stdout: 'added 1 package', stderr: '' })),
    readInstalledVersion: vi.fn(async () => TARGET),
    runVersionProbe: vi.fn(async () => TARGET),
    readTargetEngines: vi.fn(async () => null),
    nodeVersion: vi.fn(() => '26.7.0'),
  }
}

function input(deps: Fixture) {
  return { target: TARGET, installDir, root, deps }
}

function emit(event: UpgradeEvent): void {
  events.push(event)
}

function phases(): string[] {
  return events.map((event) => event.phase)
}

function backupOf(from: string): string {
  return backupDir(root, from)
}

/** 回滚契约：先删新目录，再搬回备份，顺序固定且各一次。 */
function expectRollbackTo(deps: Fixture, from: string): void {
  const backup = backupOf(from)
  expect(deps.cloneDir).toHaveBeenCalledTimes(1)
  expect(deps.cloneDir).toHaveBeenCalledWith(installDir, backup)
  expect(deps.removeDir).toHaveBeenCalledTimes(1)
  expect(deps.removeDir).toHaveBeenCalledWith(installDir)
  expect(deps.moveDir).toHaveBeenCalledTimes(1)
  expect(deps.moveDir).toHaveBeenCalledWith(backup, installDir)
}

describe('runUpgrade 前置校验', () => {
  test('engines 不满足时不动盘：只报 RUNTIME_UNSUPPORTED，连磁盘都不查', async () => {
    const deps = baseDeps()
    // 本机真实现状：node 26.7.0 不满足 0.2.3-alpha.2 的 engines
    deps.readTargetEngines.mockResolvedValue('^24.22.3 || >=26.13.1')
    deps.nodeVersion.mockReturnValue('26.7.0')

    const result = await runUpgrade(input(deps), emit)

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('RUNTIME_UNSUPPORTED')
    expect(result.error?.message).toContain('26.13.1')
    expect(result.rolledBack).toBeUndefined()
    expect(phases()).toEqual(['precheck', 'fail'])
    expect(deps.statfs).not.toHaveBeenCalled()
    expect(deps.readInstalledVersion).not.toHaveBeenCalled()
    expect(deps.cloneDir).not.toHaveBeenCalled()
    expect(deps.runNpmInstall).not.toHaveBeenCalled()
    expect(events.at(-1)?.done).toBe(true)
    expect(events.at(-1)?.error?.code).toBe('RUNTIME_UNSUPPORTED')
  })

  test('安装目录推不出前缀：INSTALL_FAILED，不读版本、不备份、不安装', async () => {
    const deps = baseDeps()
    // 少了 /lib：不猜前缀，直接失败——让 npm 自己决定前缀在 NAS 上会装到 ~/.local
    const oddDir = join(prefix, 'node_modules', '@deepseek-ai', 'dsh')

    const result = await runUpgrade({ target: TARGET, installDir: oddDir, root, deps }, emit)

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INSTALL_FAILED')
    expect(result.error?.message).toBe(
      `无法从安装目录推导 npm 全局前缀：${oddDir}（期望 <prefix>/lib/node_modules/@deepseek-ai/dsh）`,
    )
    expect(result.rolledBack).toBeUndefined()
    expect(phases()).toEqual(['precheck', 'fail'])
    expect(deps.readInstalledVersion).not.toHaveBeenCalled()
    expect(deps.cloneDir).not.toHaveBeenCalled()
    expect(deps.removeDir).not.toHaveBeenCalled()
    expect(deps.moveDir).not.toHaveBeenCalled()
    expect(deps.runNpmInstall).not.toHaveBeenCalled()
  })

  test('可用空间只有 1 GB 时 NO_SPACE：不备份、不安装', async () => {
    const deps = baseDeps()
    deps.statfs.mockResolvedValue({ bavail: 1024, bsize: MIB })

    const result = await runUpgrade(input(deps), emit)

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('NO_SPACE')
    expect(phases()).toEqual(['precheck', 'fail'])
    expect(deps.statfs).toHaveBeenCalledWith(installDir)
    expect(deps.cloneDir).not.toHaveBeenCalled()
    expect(deps.runNpmInstall).not.toHaveBeenCalled()
  })
})

describe('runUpgrade 失败回滚', () => {
  test('npm 失败：删新目录再搬回备份，各一次，报 INSTALL_FAILED', async () => {
    const deps = baseDeps()
    deps.readInstalledVersion.mockResolvedValueOnce(CURRENT)
    deps.runNpmInstall.mockResolvedValue({ code: 1, stdout: '', stderr: 'EACCES' })

    const result = await runUpgrade(input(deps), emit)

    expect(result.ok).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.error?.code).toBe('INSTALL_FAILED')
    expect(result.error?.message).toContain('EACCES')
    expectRollbackTo(deps, CURRENT)
    expect(deps.runNpmInstall).toHaveBeenCalledTimes(1)
    expect(deps.runNpmInstall).toHaveBeenCalledWith(TARGET, prefix, NPM_TIMEOUT_MS)
    expect(phases()).toEqual(['precheck', 'backup', 'install', 'rollback', 'fail'])
  })

  test('装完版本没变：VERSION_MISMATCH 并回滚', async () => {
    const deps = baseDeps()
    deps.readInstalledVersion.mockResolvedValue(CURRENT)

    const result = await runUpgrade(input(deps), emit)

    expect(result.ok).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.error?.code).toBe('VERSION_MISMATCH')
    expect(result.error?.message).toContain(CURRENT)
    expectRollbackTo(deps, CURRENT)
    expect(deps.runVersionProbe).not.toHaveBeenCalled()
    expect(phases()).toEqual(['precheck', 'backup', 'install', 'verify', 'rollback', 'fail'])
  })

  test('版本探测跑不起来：同样 VERSION_MISMATCH 并回滚', async () => {
    const deps = baseDeps()
    deps.readInstalledVersion.mockResolvedValueOnce(CURRENT).mockResolvedValueOnce(TARGET)
    deps.runVersionProbe.mockResolvedValue(null)

    const result = await runUpgrade(input(deps), emit)

    expect(result.ok).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.error?.code).toBe('VERSION_MISMATCH')
    expect(result.error?.message).toContain('无法运行')
    expectRollbackTo(deps, CURRENT)
    expect(deps.runVersionProbe).toHaveBeenCalledWith(installDir)
    expect(phases()).toEqual(['precheck', 'backup', 'install', 'verify', 'rollback', 'fail'])
  })

  test('回滚自身失败：ROLLBACK_FAILED，两条原始错误都在消息里', async () => {
    const deps = baseDeps()
    deps.readInstalledVersion.mockResolvedValueOnce(CURRENT)
    deps.runNpmInstall.mockResolvedValue({ code: 1, stdout: '', stderr: 'EACCES' })
    deps.removeDir.mockRejectedValue(new Error('rm 炸了'))
    deps.moveDir.mockRejectedValue(new Error('mv 炸了'))

    const result = await runUpgrade(input(deps), emit)

    expect(result.ok).toBe(false)
    expect(result.rolledBack).toBe(false)
    expect(result.error?.code).toBe('ROLLBACK_FAILED')
    expect(result.error?.message).toContain('rm 炸了')
    expect(result.error?.message).toContain('mv 炸了')
    // 两步都要尝试：删失败也不能不搬备份
    expect(deps.removeDir).toHaveBeenCalledWith(installDir)
    expect(deps.moveDir).toHaveBeenCalledWith(backupOf(CURRENT), installDir)
    expect(phases()).toEqual(['precheck', 'backup', 'install', 'rollback', 'fail'])
    expect(events.at(-1)?.error?.code).toBe('ROLLBACK_FAILED')
  })

  test('备份失败：不安装也不回滚，报 INSTALL_FAILED', async () => {
    const deps = baseDeps()
    deps.readInstalledVersion.mockResolvedValueOnce(CURRENT)
    deps.cloneDir.mockRejectedValue(new Error('cp 炸了'))

    const result = await runUpgrade(input(deps), emit)

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INSTALL_FAILED')
    expect(result.error?.message).toContain('备份失败')
    expect(result.error?.message).toContain('cp 炸了')
    expect(deps.cloneDir).toHaveBeenCalledWith(installDir, backupOf(CURRENT))
    expect(deps.runNpmInstall).not.toHaveBeenCalled()
    expect(deps.removeDir).not.toHaveBeenCalled()
    expect(deps.moveDir).not.toHaveBeenCalled()
    expect(phases()).toEqual(['precheck', 'backup', 'fail'])
  })
})

describe('runUpgrade 成功路径', () => {
  test('precheck → backup → install → verify → done，删备份一次；2500 MB 整好放行', async () => {
    const deps = baseDeps()
    // 正好等于阈值也放行：门槛是「≥ 2500 MB」
    deps.statfs.mockResolvedValue({ bavail: 2500 * 1024, bsize: 1024 })
    deps.readInstalledVersion.mockResolvedValueOnce(CURRENT).mockResolvedValueOnce(TARGET)

    const result = await runUpgrade(input(deps), emit)

    expect(result).toEqual({ ok: true })
    expect(phases()).toEqual(['precheck', 'backup', 'install', 'verify', 'done'])
    expect(deps.cloneDir).toHaveBeenCalledWith(installDir, backupOf(CURRENT))
    expect(deps.removeDir).toHaveBeenCalledTimes(1)
    expect(deps.removeDir).toHaveBeenCalledWith(backupOf(CURRENT))
    expect(deps.moveDir).not.toHaveBeenCalled()
    expect(deps.runNpmInstall).toHaveBeenCalledWith(TARGET, prefix, NPM_TIMEOUT_MS)
    expect(deps.runVersionProbe).toHaveBeenCalledWith(installDir)
    expect(events.at(-1)?.done).toBe(true)
    for (const event of events) {
      expect(event.message.length).toBeGreaterThan(0)
      expect(event.error).toBeUndefined()
    }
  })
})
