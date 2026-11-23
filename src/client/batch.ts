/**
 * 串行批量升级队列。
 *
 * dshmarket 一次只接受一个包，也不允许两个操作同时跑，所以「全部升级」只能
 * 在客户端排队：起一个包、轮询到终态、再起下一个。这个文件不碰 DOM，也不读
 * 全局状态，只把每个包的进展通过 onEvent 发出去，最后给一份汇总。
 *
 * 失败留在失败包自己身上：一个包装挂了、卡住了、回滚了，都接着升下一个；
 * 只有调用方叫停（关面板）或宿主已有升级在跑（OPERATION_BUSY），才把剩下的
 * 包标成 skipped。
 */

import {
  isPluginUnavailableCode,
  pollPluginOperation,
  startPluginUpdate,
  UNAVAILABLE_MESSAGE,
  type PluginOperation,
} from './market'

export type BatchItemState = 'pending' | 'running' | 'succeeded' | 'failed'

export type BatchItem = {
  name: string
  state: BatchItemState
  /** pnpm 报的百分比；没有总量时为 null。 */
  percent: number | null
  /** pnpm 这一轮在干什么；没有时为 null。 */
  detail: string | null
  /** 失败/回滚/取消/卡住的原因；排队时是「还在等谁」。 */
  message: string | null
  /** 请求层不可用（市场没开、登录失效、记录丢失），不是安装失败。 */
  unavailable: boolean
}

export type BatchEvent = { kind: 'running' | 'settled'; item: BatchItem }

export type BatchSummary = {
  succeeded: string[]
  failed: string[]
  skipped: string[]
  restartRequired: boolean
}

export type BatchOptions = {
  pollIntervalMs?: number
  stalledWaitMs?: number
  /** 面板关了就该停：返回 true 时剩余包进 skipped，不再发请求。 */
  cancelled?(): boolean
  onEvent?(event: BatchEvent): void
}

/** 与面板同款节奏：800ms 一问、最多 20 分钟、3 分钟没推进算卡住。 */
export const DEFAULT_POLL_INTERVAL_MS = 800
export const MAX_POLLS = 1500
export const DEFAULT_STALLED_WAIT_MS = 180_000

/** 宿主已经有一个升级在跑：再起只会被同样拒绝，整批直接收尾。 */
const HOST_BUSY_CODE = 'OPERATION_BUSY'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function itemOf(name: string, state: BatchItemState): BatchItem {
  return { name, state, percent: null, detail: null, message: null, unavailable: false }
}

/** 稀疏数组的空洞没有名字，用空串占位，保证三段计数加起来等于 names.length。 */
function restNames(names: string[], from: number): string[] {
  const rest: string[] = []
  for (let index = from; index < names.length; index += 1) rest.push(names[index] ?? '')
  return rest
}

/** 判定「还在动」的指纹：状态、百分比、pnpm 输出任一变化都算推进。 */
function moveKey(operation: PluginOperation): string {
  const progress = operation.progress
  return [
    operation.status,
    String(progress?.percent ?? ''),
    String(progress?.done ?? ''),
    String(progress?.detail ?? ''),
  ].join('|')
}

/** 一直没推进时留在行里的话：等会话结束和真在跑要分开说，别让人以为装了一半。 */
function stalledReason(operation: PluginOperation): string {
  const agents = operation.wait?.activeAgentIds.length ?? 0
  if (operation.status === 'queued' || agents > 0) {
    return agents > 0
      ? '还没开始升级：等 ' + String(agents) + ' 个运行中的会话结束后再点'
      : '还没开始升级：一直在排队，稍后再点'
  }
  return '升级还在后台跑，先不等了：稍后打开面板看结果'
}

/** 排队时把「等几个会话」写在行里；运行中不重复 pnpm 的整段输出。 */
function runningMessage(operation: PluginOperation): string | null {
  if (operation.status !== 'queued') return null
  const agents = operation.wait?.activeAgentIds.length ?? 0
  return agents > 0 ? '等 ' + String(agents) + ' 个运行中的会话结束' : null
}

/** 终态 → 行里的那份状态。成功之外都算 failed（BatchItemState 没有回滚/取消）。 */
function settleItem(name: string, operation: PluginOperation): BatchItem {
  const item = itemOf(name, 'succeeded')
  if (operation.status === 'succeeded') return item
  item.state = 'failed'
  switch (operation.status) {
    case 'failed':
      if (isPluginUnavailableCode(operation.code)) {
        item.unavailable = true
        item.message = UNAVAILABLE_MESSAGE
      } else {
        item.message = operation.message ?? '升级失败'
      }
      break
    case 'rolled-back':
      item.message = operation.message === undefined ? '已回滚' : '已回滚：' + operation.message
      break
    case 'cancelled':
      item.message = '已取消'
      break
  }
  return item
}

/** hostBusy：宿主上已经有升级在跑，后面的包不可能成功，整批就此收尾。 */
type BatchOutcome = { ok: boolean; restartRequired: boolean; hostBusy: boolean }

/** 升级一个包：起操作、轮询到终态。不抛异常——失败都变成 settled 事件。 */
async function upgradeOne(
  name: string,
  f: typeof fetch,
  base: string,
  interval: number,
  stalledWaitMs: number,
  emit: (event: BatchEvent) => void,
): Promise<BatchOutcome> {
  const started = await startPluginUpdate(name, f, base)
  if (started.operationId === '') {
    const item = itemOf(name, 'failed')
    if (isPluginUnavailableCode(started.code)) {
      item.unavailable = true
      item.message = UNAVAILABLE_MESSAGE
    } else {
      item.message =
        started.message !== undefined && started.message !== '' ? started.message : '升级失败'
    }
    emit({ kind: 'settled', item })
    return {
      ok: false,
      restartRequired: false,
      hostBusy: started.code === HOST_BUSY_CODE,
    }
  }

  let lastMove = ''
  let movedAt = Date.now()
  for (let round = 0; round < MAX_POLLS; round += 1) {
    const operation = await pollPluginOperation(started.operationId, f, base)
    if (operation.status === 'queued' || operation.status === 'running') {
      const move = moveKey(operation)
      if (move !== lastMove) {
        lastMove = move
        movedAt = Date.now()
      } else if (Date.now() - movedAt >= stalledWaitMs) {
        // 卡在「等会话结束」这类前进不了的地方：把原因留在这一行，接着升下一个。
        const item = itemOf(name, 'failed')
        item.message = stalledReason(operation)
        emit({ kind: 'settled', item })
        return { ok: false, restartRequired: false, hostBusy: false }
      }
      const item = itemOf(name, 'running')
      item.percent = operation.progress?.percent ?? null
      item.detail = operation.progress?.detail ?? null
      item.message = runningMessage(operation)
      emit({ kind: 'running', item })
      await sleep(interval)
      continue
    }
    const item = settleItem(name, operation)
    emit({ kind: 'settled', item })
    return {
      ok: item.state === 'succeeded',
      restartRequired: item.state === 'succeeded' && operation.restartRequired,
      hostBusy: false,
    }
  }

  // 轮询次数用完还没终态：和面板超时同口径，别无限等。
  const timeout = itemOf(name, 'failed')
  timeout.message = '升级超时，稍后重试'
  emit({ kind: 'settled', item: timeout })
  return { ok: false, restartRequired: false, hostBusy: false }
}

/**
 * 按 names 顺序串行升级，返回汇总。
 *
 * 起每个包之前先问 cancelled()：已经叫停就把当前包和剩下的全部标成
 * skipped 并立即返回，不再发请求。宿主回 OPERATION_BUSY 时同样收尾：那一个
 * 包记 failed，其余进 skipped。除此之外不提前结束——一个包失败不影响后面。
 */
export async function runBatch(
  names: string[],
  f: typeof fetch,
  base: string,
  options: BatchOptions = {},
): Promise<BatchSummary> {
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const stalledWaitMs = options.stalledWaitMs ?? DEFAULT_STALLED_WAIT_MS
  const summary: BatchSummary = { succeeded: [], failed: [], skipped: [], restartRequired: false }
  const emit = (event: BatchEvent): void => {
    try {
      options.onEvent?.(event)
    } catch {
      // 面板绘制出错不能吞掉整批：事件只是通知，队列照常往下升。
    }
  }

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    if (name === undefined) {
      // 空洞没有名字，不能静默漏项：用空串占一个 skipped 名额。
      summary.skipped.push('')
      continue
    }
    if (options.cancelled?.() === true) {
      summary.skipped.push(...restNames(names, index))
      return summary
    }
    const outcome = await upgradeOne(name, f, base, interval, stalledWaitMs, emit)
    if (outcome.ok) {
      summary.succeeded.push(name)
      if (outcome.restartRequired) summary.restartRequired = true
    } else {
      summary.failed.push(name)
      if (outcome.hostBusy) {
        // 宿主上已有升级在跑，后面的包必然同样被拒，别再连报 N 次。
        summary.skipped.push(...restNames(names, index + 1))
        return summary
      }
    }
  }
  return summary
}
