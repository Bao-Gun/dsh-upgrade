/**
 * 全局唯一的升级锁（R24）：HTTP 路由与 agent 工具抢同一把锁。
 *
 * 检查与置位必须在同一个同步块里完成，中间不能有 await，否则两个并发调用都能过门；
 * 释放一律走 finally，升级抛错不会把锁永久占住。
 */
let running = false

export function tryAcquireUpgrade(): boolean {
  if (running) return false
  running = true
  return true
}

export function releaseUpgrade(): void {
  running = false
}
