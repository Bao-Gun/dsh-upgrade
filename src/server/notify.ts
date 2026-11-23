import { spawn } from 'node:child_process'
import { clearPending, readPending, writePending, type Pending } from './state'

/**
 * R19：这个模块是唯一决定「升级成功了，该告诉用户」的地方，对调用方永不抛。
 * osascript 失败、marker 坏掉、文件不存在，一律降级成静默。
 */
export type NotifyDeps = {
  runOsascript(script: string): Promise<boolean>
}

type Outcome = 'notify' | 'wait' | 'clear' | 'none'

/** R20：7 天只是「用户早就自己发现了」的陈旧保护，不是正确性规则 */
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000
const NOTIFICATION_TITLE = 'DSH 已升级'

/** 双引号先转义，否则版本串会提前结束 AppleScript 字符串 */
function escapeForAppleScript(text: string): string {
  return text.replace(/"/g, '\\"')
}

function notificationScript(to: string): string {
  const body = `已升级到 ${escapeForAppleScript(to)}，进程已重启`
  return `display notification "${body}" with title "${NOTIFICATION_TITLE}"`
}

/** 默认实现：spawn osascript，退出码非 0 / 起不来都算 false，绝不抛 */
function runOsascriptDefault(script: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const child = spawn('osascript', ['-e', script], { stdio: 'ignore' })
      child.on('error', () => finish(false))
      child.on('close', (code) => finish(code === 0))
    } catch {
      finish(false)
    }
  })
}

/** 先写 marker 再重启：重启会杀掉看着页面的那个进程，只能靠下次加载补通知 */
export async function markPending(
  from: string,
  to: string,
  now: number = Date.now(),
): Promise<void> {
  // 写不进去只意味着「没有通知」，不能让升级流程或页面加载跟着失败
  await writePending({ from, to, startedAt: now }).catch(() => {})
}

function decide(pending: Pending, current: string, now: number): Outcome {
  if (now - pending.startedAt > PENDING_TTL_MS) return 'clear'
  if (current === pending.to) return 'notify'
  if (current === pending.from) return 'wait'
  return 'clear'
}

export async function resolvePending(
  current: string,
  now: number = Date.now(),
): Promise<'notify' | 'wait' | 'clear' | 'none'> {
  const pending = await readPending()
  if (pending === null) return 'none'
  return decide(pending, current, now)
}

export async function notifyUpgraded(
  to: string,
  deps?: Partial<NotifyDeps>,
): Promise<boolean> {
  const run = deps?.runOsascript ?? runOsascriptDefault
  try {
    return (await run(notificationScript(to))) === true
  } catch {
    return false
  }
}

/**
 * 页面加载时调用一次。marker 的三种终局都收在这里：
 * notify → 通知一次；clear → 直接清；wait / none → 什么都不做。
 * 清 marker 放在 finally，通知失败也不会让它每次加载都再响一遍。
 */
export async function settlePending(
  current: string,
  now: number = Date.now(),
  deps?: Partial<NotifyDeps>,
): Promise<void> {
  const pending = await readPending()
  if (pending === null) return

  // 剩下的三种终局：notify 通知后清、clear 直接清、wait 留给下次加载
  const outcome = decide(pending, current, now)
  if (outcome === 'wait') return

  try {
    if (outcome === 'notify') await notifyUpgraded(pending.to, deps)
  } finally {
    await clearPending()
  }
}
