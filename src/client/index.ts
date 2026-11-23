import { setEntryState, mountFooterEntry } from './inject'
import { openPanel, probeHasUpdate } from './panel'

type ClientContext = {
  effect?(fn: () => void): unknown
}

/**
 * 客户端入口。
 *
 * 挂载顺序是硬约束：先 mount（找座位、插按钮）→ 再拉状态 → 最后 setEntryState。
 * inject.ts 的 setEntryState 只改已经存在的节点，座位没着落时设状态会被静默丢掉。
 */
export function apply(ctx?: ClientContext): void {
  if (typeof document === 'undefined') return
  const doc = document
  let disposed = false

  const teardownEntry = mountFooterEntry(doc, {
    onOpen: () => {
      void openPanel(doc, {
        onState: (state) => {
          if (!disposed) setEntryState(doc, state)
        },
      })
    },
  })

  const stop = (): void => {
    if (disposed) return
    disposed = true
    teardownEntry()
  }

  if (ctx !== undefined && typeof ctx.effect === 'function') {
    // 宿主是 cordis：effect 会立刻执行传入函数，并把它的返回值当 disposer。
    // 所以这里必须传「返回 stop 的函数」，不能直接传 stop——否则 apply 刚挂上入口就被拆掉。
    ctx.effect(() => stop)
  } else {
    const view = doc.defaultView
    if (view !== null) view.addEventListener('pagehide', stop, { once: true })
  }

  void probeHasUpdate(doc)
    .then((hasUpdate) => {
      if (!disposed) setEntryState(doc, { hasUpdate, busy: false })
    })
    .catch(() => {
      if (!disposed) setEntryState(doc, { hasUpdate: false, busy: false })
    })
}
