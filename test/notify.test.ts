import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPending, writePending } from '../src/server/state'
import {
  markPending,
  notifyCommand,
  notifyUpgraded,
  runNotifyDefault,
  settlePending,
} from '../src/server/notify'

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const NOW = 1_700_000_000_000
const FROM = '0.2.2-rc.5'
const TO = '0.2.3-alpha.2'
const TITLE = 'DSH 已升级'
const BODY = `已升级到 ${TO}，进程已重启`

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

/** 记录 runNotify 收到的 argv，永远不真的 spawn 通知程序 */
function recorder(result: boolean = true) {
  const calls: string[][] = []
  return {
    calls,
    deps: {
      runNotify: async (argv: string[]): Promise<boolean> => {
        calls.push(argv)
        return result
      },
    },
  }
}

function throwingDeps() {
  const calls: string[][] = []
  return {
    calls,
    deps: {
      runNotify: async (argv: string[]): Promise<boolean> => {
        calls.push(argv)
        throw new Error('通知程序不可用')
      },
    },
  }
}

describe('notifyCommand', () => {
  test('darwin：osascript + 转义后的 AppleScript', () => {
    expect(notifyCommand('darwin', TITLE, BODY)).toEqual([
      'osascript',
      '-e',
      'display notification "已升级到 0.2.3-alpha.2，进程已重启" with title "DSH 已升级"',
    ])
  })

  test('darwin：正文里的双引号先转义', () => {
    expect(notifyCommand('darwin', TITLE, '已升级到 0.2.3"beta，进程已重启')).toEqual([
      'osascript',
      '-e',
      'display notification "已升级到 0.2.3\\"beta，进程已重启" with title "DSH 已升级"',
    ])
  })

  test('linux：notify-send <title> <body>，正文原样不转义', () => {
    expect(notifyCommand('linux', TITLE, BODY)).toEqual(['notify-send', TITLE, BODY])
    expect(notifyCommand('linux', TITLE, '已升级到 0.2.3"beta，进程已重启')).toEqual([
      'notify-send',
      TITLE,
      '已升级到 0.2.3"beta，进程已重启',
    ])
  })

  test('其它平台（win32 等）：空 argv，什么都不发', () => {
    expect(notifyCommand('win32', TITLE, BODY)).toEqual([])
  })
})

describe('runNotifyDefault', () => {
  test('空 argv 直接返回 false，不 spawn', async () => {
    await expect(runNotifyDefault([])).resolves.toBe(false)
  })

  test('命令起不来（不存在）时返回 false，不抛', async () => {
    await expect(runNotifyDefault(['dsh-upgrade-no-such-binary-xyz'])).resolves.toBe(false)
  })

  test('退出码非 0 时返回 false，0 时返回 true', async () => {
    await expect(runNotifyDefault(['/bin/sh', '-c', 'exit 3'])).resolves.toBe(false)
    await expect(runNotifyDefault(['/bin/sh', '-c', 'exit 0'])).resolves.toBe(true)
  })
})

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

describe('settlePending', () => {
  test('notify 分支：通知一次、argv 里带目标版本，然后清掉 marker', async () => {
    await markPending(FROM, TO, NOW)
    const { calls, deps } = recorder(true)

    await settlePending(TO, NOW, deps)

    expect(calls).toHaveLength(1)
    const sent = JSON.stringify(calls[0])
    expect(sent).toContain(TO)
    expect(sent).toContain(TITLE)
    expect(await readPending()).toBeNull()
  })

  test('同一次成功的 settlePending 之后再来一次：不再通知', async () => {
    await markPending(FROM, TO, NOW)
    const { calls, deps } = recorder(true)

    await settlePending(TO, NOW, deps)
    await settlePending(TO, NOW, deps)

    expect(calls).toHaveLength(1)
    expect(await readPending()).toBeNull()
  })

  test('runNotify 抛错时不往外抛，但 marker 仍被清掉', async () => {
    await markPending(FROM, TO, NOW)
    const { calls, deps } = throwingDeps()

    await expect(settlePending(TO, NOW, deps)).resolves.toBeUndefined()

    expect(calls).toHaveLength(1)
    expect(await readPending()).toBeNull()
  })

  test('runNotify 返回 false 时同样清掉 marker，不重复通知', async () => {
    await markPending(FROM, TO, NOW)
    const { calls, deps } = recorder(false)

    await settlePending(TO, NOW, deps)
    await settlePending(TO, NOW, deps)

    expect(calls).toHaveLength(1)
    expect(await readPending()).toBeNull()
  })

  test('wait 分支：不通知，marker 留着等下次加载', async () => {
    await markPending(FROM, TO, NOW)
    const { calls, deps } = recorder(true)

    await settlePending(FROM, NOW, deps)

    expect(calls).toHaveLength(0)
    expect(await readPending()).toEqual({ from: FROM, to: TO, startedAt: NOW })
  })

  test('clear 分支：不通知，marker 清掉', async () => {
    await markPending(FROM, TO, NOW)
    const { calls, deps } = recorder(true)

    await settlePending('0.2.1', NOW, deps)

    expect(calls).toHaveLength(0)
    expect(await readPending()).toBeNull()
  })

  test('恰好在 7 天整仍算新鲜：通知并清掉', async () => {
    await markPending(FROM, TO, NOW)
    const { calls, deps } = recorder(true)

    await settlePending(TO, NOW + 7 * DAY, deps)

    expect(calls).toHaveLength(1)
    expect(await readPending()).toBeNull()
  })

  test('过期判断以 startedAt 为准，不随 now 漂移', async () => {
    await markPending(FROM, TO, NOW)
    const { calls, deps } = recorder(true)

    await settlePending(TO, NOW + 6 * DAY, deps)
    expect(calls).toHaveLength(1)

    await markPending(FROM, TO, NOW)
    await settlePending(TO, NOW + 8 * DAY, deps)
    expect(calls).toHaveLength(1)
    expect(await readPending()).toBeNull()
  })

  test('过期 marker 走 clear：不通知也不抛', async () => {
    await markPending(FROM, TO, NOW)
    const { calls, deps } = recorder(true)

    await settlePending(TO, NOW + 7 * DAY + 1, deps)

    expect(calls).toHaveLength(0)
    expect(await readPending()).toBeNull()
  })

  test('没有 marker 时什么都不做', async () => {
    const { calls, deps } = recorder(true)
    await expect(settlePending(TO, NOW, deps)).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test('坏 marker 文件不抛、不通知', async () => {
    await writeFile(join(dir, 'pending.json'), '', 'utf8')
    const { calls, deps } = recorder(true)
    await expect(settlePending(TO, NOW, deps)).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test('marker 读不出来（目录不存在）时静默返回', async () => {
    process.env.DSH_UPGRADE_ROOT = join(dir, 'not', 'yet')
    const { calls, deps } = recorder(true)
    await expect(settlePending(TO, NOW, deps)).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

describe('notifyUpgraded', () => {
  test('成功时返回 true，argv 与当前平台分支一致', async () => {
    const { calls, deps } = recorder(true)
    await expect(notifyUpgraded(TO, deps)).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(notifyCommand(process.platform, TITLE, BODY))
  })

  test('通知程序返回 false 时返回 false', async () => {
    const { deps } = recorder(false)
    await expect(notifyUpgraded(TO, deps)).resolves.toBe(false)
  })

  test('通知程序抛错时返回 false，不抛给调用方', async () => {
    const { deps } = throwingDeps()
    await expect(notifyUpgraded(TO, deps)).resolves.toBe(false)
  })
})
