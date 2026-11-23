import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPending, writePending } from '../src/server/state'
import { markPending, notifyUpgraded, resolvePending, settlePending } from '../src/server/notify'

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const NOW = 1_700_000_000_000
const FROM = '0.2.2-rc.5'
const TO = '0.2.3-alpha.2'

let dir: string
const originalRoot = process.env.DSH_UPGRADE_ROOT

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-upgrade-notify-'))
  process.env.DSH_UPGRADE_ROOT = dir
})

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.DSH_UPGRADE_ROOT
  else process.env.DSH_UPGRADE_ROOT = originalRoot
  await rm(dir, { recursive: true, force: true })
})

/** 记录 osascript 收到的脚本，永远不真的调起 osascript */
function recorder(result: boolean = true) {
  const scripts: string[] = []
  return {
    scripts,
    deps: {
      runOsascript: async (script: string): Promise<boolean> => {
        scripts.push(script)
        return result
      },
    },
  }
}

function throwingDeps() {
  const scripts: string[] = []
  return {
    scripts,
    deps: {
      runOsascript: async (script: string): Promise<boolean> => {
        scripts.push(script)
        throw new Error('osascript 不可用')
      },
    },
  }
}

describe('markPending', () => {
  test('写入 from / to 与传入的 startedAt', async () => {
    await markPending(FROM, TO, NOW)
    expect(await readPending()).toEqual({ from: FROM, to: TO, startedAt: NOW })
  })

  test('不传 now 时用当前时间做 startedAt', async () => {
    const before = Date.now()
    await markPending(FROM, TO)
    const pending = await readPending()
    expect(pending?.startedAt).toBeGreaterThanOrEqual(before)
    expect(pending?.startedAt).toBeLessThanOrEqual(Date.now())
  })
})

describe('resolvePending 的四种结局', () => {
  test('没有 marker → none', async () => {
    expect(await resolvePending(TO, NOW)).toBe('none')
  })

  test('运行版本等于目标版本 → notify', async () => {
    await markPending(FROM, TO, NOW)
    expect(await resolvePending(TO, NOW)).toBe('notify')
  })

  test('运行版本仍是从前那个 → wait（重启还没发生或正在发生）', async () => {
    await markPending(FROM, TO, NOW)
    expect(await resolvePending(FROM, NOW)).toBe('wait')
  })

  test('第三个无关版本 → clear', async () => {
    await markPending(FROM, TO, NOW)
    expect(await resolvePending('0.2.1', NOW)).toBe('clear')
  })

  test('坏 marker 文件 → none，不抛', async () => {
    await writeFile(join(dir, 'pending.json'), '{"from":"0.2.1"', 'utf8')
    expect(await resolvePending(TO, NOW)).toBe('none')
  })
})

describe('resolvePending 的 7 天过期边界', () => {
  test('恰好在 7 天整仍算新鲜 → notify', async () => {
    await markPending(FROM, TO, NOW)
    expect(await resolvePending(TO, NOW + 7 * DAY)).toBe('notify')
  })

  test('超过 7 天 1 毫秒就过期 → clear，即使版本已经对上了', async () => {
    await markPending(FROM, TO, NOW)
    expect(await resolvePending(TO, NOW + 7 * DAY + 1)).toBe('clear')
  })

  test('过期优先于 wait：版本仍是 from 也清掉', async () => {
    await markPending(FROM, TO, NOW)
    expect(await resolvePending(FROM, NOW + 7 * DAY + 1)).toBe('clear')
  })

  test('过期判断以 startedAt 为准，不随 now 漂移', async () => {
    await markPending(FROM, TO, NOW)
    expect(await resolvePending(TO, NOW + 6 * DAY)).toBe('notify')
    expect(await resolvePending(TO, NOW + 8 * DAY)).toBe('clear')
  })
})

describe('settlePending', () => {
  test('notify 分支：通知一次、脚本里带目标版本，然后清掉 marker', async () => {
    await markPending(FROM, TO, NOW)
    const { scripts, deps } = recorder(true)

    await settlePending(TO, NOW, deps)

    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain(TO)
    expect(scripts[0]).toContain('display notification')
    expect(scripts[0]).toContain('DSH 已升级')
    expect(await readPending()).toBeNull()
    expect(await resolvePending(TO, NOW)).toBe('none')
  })

  test('同一次成功的 settlePending 之后再来一次：不再通知', async () => {
    await markPending(FROM, TO, NOW)
    const { scripts, deps } = recorder(true)

    await settlePending(TO, NOW, deps)
    await settlePending(TO, NOW, deps)

    expect(scripts).toHaveLength(1)
    expect(await readPending()).toBeNull()
  })

  test('runOsascript 抛错时不往外抛，但 marker 仍被清掉', async () => {
    await markPending(FROM, TO, NOW)
    const { scripts, deps } = throwingDeps()

    await expect(settlePending(TO, NOW, deps)).resolves.toBeUndefined()

    expect(scripts).toHaveLength(1)
    expect(await readPending()).toBeNull()
  })

  test('runOsascript 返回 false 时同样清掉 marker，不重复通知', async () => {
    await markPending(FROM, TO, NOW)
    const { scripts, deps } = recorder(false)

    await settlePending(TO, NOW, deps)
    await settlePending(TO, NOW, deps)

    expect(scripts).toHaveLength(1)
    expect(await readPending()).toBeNull()
  })

  test('wait 分支：不通知，marker 留着等下次加载', async () => {
    await markPending(FROM, TO, NOW)
    const { scripts, deps } = recorder(true)

    await settlePending(FROM, NOW, deps)

    expect(scripts).toHaveLength(0)
    expect(await readPending()).toEqual({ from: FROM, to: TO, startedAt: NOW })
  })

  test('clear 分支：不通知，marker 清掉', async () => {
    await markPending(FROM, TO, NOW)
    const { scripts, deps } = recorder(true)

    await settlePending('0.2.1', NOW, deps)

    expect(scripts).toHaveLength(0)
    expect(await readPending()).toBeNull()
  })

  test('过期 marker 走 clear：不通知也不抛', async () => {
    await markPending(FROM, TO, NOW)
    const { scripts, deps } = recorder(true)

    await settlePending(TO, NOW + 7 * DAY + 1, deps)

    expect(scripts).toHaveLength(0)
    expect(await readPending()).toBeNull()
  })

  test('没有 marker 时什么都不做', async () => {
    const { scripts, deps } = recorder(true)
    await expect(settlePending(TO, NOW, deps)).resolves.toBeUndefined()
    expect(scripts).toHaveLength(0)
  })

  test('坏 marker 文件不抛、不通知', async () => {
    await writeFile(join(dir, 'pending.json'), '', 'utf8')
    const { scripts, deps } = recorder(true)
    await expect(settlePending(TO, NOW, deps)).resolves.toBeUndefined()
    expect(scripts).toHaveLength(0)
  })

  test('marker 读不出来（目录不存在）时静默返回', async () => {
    process.env.DSH_UPGRADE_ROOT = join(dir, 'not', 'yet')
    const { scripts, deps } = recorder(true)
    await expect(settlePending(TO, NOW, deps)).resolves.toBeUndefined()
    expect(scripts).toHaveLength(0)
  })
})

describe('notifyUpgraded', () => {
  test('成功时返回 true，通知文案是中文并带目标版本', async () => {
    const { scripts, deps } = recorder(true)
    await expect(notifyUpgraded(TO, deps)).resolves.toBe(true)
    expect(scripts[0]).toBe(
      'display notification "已升级到 0.2.3-alpha.2，进程已重启" with title "DSH 已升级"',
    )
  })

  test('osascript 返回 false 时返回 false', async () => {
    const { deps } = recorder(false)
    await expect(notifyUpgraded(TO, deps)).resolves.toBe(false)
  })

  test('osascript 抛错时返回 false，不抛给调用方', async () => {
    const { deps } = throwingDeps()
    await expect(notifyUpgraded(TO, deps)).resolves.toBe(false)
  })

  test('版本串里的双引号先转义再嵌进 AppleScript 字符串', async () => {
    const { scripts, deps } = recorder(true)
    await notifyUpgraded('0.2.3"beta', deps)
    expect(scripts[0]).toBe(
      'display notification "已升级到 0.2.3\\"beta，进程已重启" with title "DSH 已升级"',
    )
  })
})
