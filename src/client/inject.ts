/**
 * 侧边栏底部的升级入口。
 *
 * 那一行不是宿主给插件留的座位：手机图标是别的插件自己插进 DOM 的普通节点，
 * 宿主重渲染时会整棵丢掉。所以这里按三级退路找缝，挂上后盯着 DOM，掉线就补回来：
 *
 *   ① 手机/电脑那颗图标组（[data-dshm-footer-group]）的后面——用户要的位置；
 *   ② 没有组就放进 sidebar.footer.action 那一行末尾；
 *   ③ 连动作位都没有，就追加到头像出口（settings.launcher）所在那一行末尾。
 *
 * 三处都认不出来时什么都不画——外壳可能正渲染到一半，下一帧会再试。
 * 这一颗是纯 DOM：不取数据、不渲染面板、不知道升级怎么做，点一下只转交 onOpen。
 */

export const MARK = 'data-dshu-entry'

const GROUP_SELECTOR = '[data-dshm-footer-group]'
const ACTION_SLOT_SELECTOR = '[data-slot="sidebar.footer.action"]'
const LAUNCHER_SELECTOR = '[data-slot="settings.launcher"]'
const STYLE_ID = 'dshu-entry-style'
const SVG_NS = 'http://www.w3.org/2000/svg'

/** 每个文档只允许一份挂载：重复 mount 先卸旧的，避免两个观察器互相抢位置。 */
const mountedEntries = new WeakMap<Document, () => void>()

/** 与那一行同重量：28 的方钮、20 的图标，颜色全走宿主的 --dsw-* 变量。 */
const STYLE_TEXT = [
  '.dshu-entry{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin:0 2px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}',
  '.dshu-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,inherit)}',
  '.dshu-entry:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:-2px}',
  '.dshu-entry[data-busy]{opacity:.6;cursor:default}',
  '.dshu-entry[data-busy] svg{animation:dshu-spin 1s linear infinite}',
  '.dshu-entry .dshu-dot{display:none;position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#e5484d)}',
  '.dshu-entry[data-has-update] .dshu-dot{display:block}',
  // 没更新时整颗收起来；这条必须写在 .dshu-entry{display:inline-flex} 之后才压得住它。
  '.dshu-entry[hidden]{display:none}',
  '@keyframes dshu-spin{to{transform:rotate(360deg)}}',
].join('\n')

type Hooks = { onOpen(): void }

/** 入口的对外状态；known === false 表示「没查成」，此时保持可见。 */
type EntryState = { hasUpdate: boolean; busy: boolean; known?: boolean }

/** 每个文档最近一次状态：座位晚到（外壳还没画完底栏）时，挂上后要把它补回来。 */
const entryStates = new WeakMap<Document, EntryState>()

/** 一个可插入的位置：parent 里、before 之前（before 为 null 表示末尾）。 */
type Seat = { parent: Element; before: ChildNode | null }

/** 按 ①组后 → ②动作位尾 → ③头像行尾 逐级找缝；都没有返回 null。 */
function locateSeat(doc: Document): Seat | null {
  const group = doc.querySelector(GROUP_SELECTOR)
  if (group !== null && group.parentElement !== null) {
    return { parent: group.parentElement, before: group.nextSibling }
  }

  const actionSlot = doc.querySelector(ACTION_SLOT_SELECTOR)
  if (actionSlot !== null) return { parent: actionSlot, before: null }

  const launcher = doc.querySelector(LAUNCHER_SELECTOR)
  if (launcher !== null && launcher.parentElement !== null) {
    return { parent: launcher.parentElement, before: null }
  }

  return null
}

function createGlyph(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '20')
  svg.setAttribute('height', '20')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')

  // 向上的箭头 + 托盘：一眼看出是「升级」。
  const arrow = doc.createElementNS(SVG_NS, 'path')
  arrow.setAttribute('d', 'M12 4v10')
  svg.appendChild(arrow)
  const head = doc.createElementNS(SVG_NS, 'path')
  head.setAttribute('d', 'M8 8l4-4 4 4')
  svg.appendChild(head)
  const tray = doc.createElementNS(SVG_NS, 'path')
  tray.setAttribute('d', 'M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15')
  svg.appendChild(tray)

  return svg
}

function createEntry(doc: Document, hooks: Hooks): HTMLButtonElement {
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = 'dshu-entry'
  button.setAttribute(MARK, '')
  button.setAttribute('aria-label', '检查更新')
  button.title = '检查更新'
  button.appendChild(createGlyph(doc))

  // 角标常驻，显不显示交给 CSS 的 [data-has-update]：外壳重渲染时不用重新算状态。
  const dot = doc.createElement('span')
  dot.className = 'dshu-dot'
  dot.setAttribute('aria-hidden', 'true')
  button.appendChild(dot)

  button.addEventListener('click', () => hooks.onOpen())
  return button
}

/** 样式只注入一次，按 id 判重；卸载时连根摘掉。 */
function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  doc.head.appendChild(style)
}

/**
 * 把升级入口挂到底栏，返回卸载函数。
 *
 * 挂上之后观察 document.body：外壳整棵重建那一行时节点会掉线，下一帧补回去。
 * 观察器只在「按钮不在该在的位置」时写 DOM，写完不再自我触发（合并到一帧一次）。
 */
export function mountFooterEntry(doc: Document, hooks: Hooks): () => void {
  // 同一页面里重复挂载（插件重装、热更新）时，先把上一份彻底卸掉：
  // 否则两个观察器会各自把按钮往同一个缝里塞，来回打架、永远不收敛。
  const previous = mountedEntries.get(doc)
  if (previous !== undefined) previous()

  ensureStyle(doc)

  // 再摘掉别处遗留的节点（跨实现残留），保证页面上只有一颗。
  for (const stale of Array.from(doc.querySelectorAll(`[${MARK}]`))) stale.remove()

  const button = createEntry(doc, hooks)
  // 目标环境是浏览器，requestAnimationFrame 一定有；没有就只挂这一次，不盯 DOM。
  const frameHost =
    doc.defaultView !== null &&
    typeof doc.defaultView.requestAnimationFrame === 'function' &&
    typeof doc.defaultView.cancelAnimationFrame === 'function'
      ? doc.defaultView
      : null

  let observer: MutationObserver | null = null
  let frame: number | null = null
  let disposed = false

  const settle = (): void => {
    if (disposed) return

    const seat = locateSeat(doc)
    if (seat === null) {
      // 外壳正把这一行整棵拆掉：此刻没有缝，先把自己摘下来，等它重建好再挂。
      if (button.parentElement !== null) button.remove()
      return
    }

    const placed =
      button.parentElement === seat.parent &&
      (seat.before === button || button.nextSibling === seat.before)
    if (placed) return

    seat.parent.insertBefore(button, seat.before)
    // 座位可能比状态晚到（外壳先返回、底栏后渲染）：挂上的这一瞬间把记着的状态补上，
    // 否则那一颗会以「默认可见」的样子留在底栏，直到下一次静默查询。
    const remembered = entryStates.get(doc)
    if (remembered !== undefined) paintEntry(button, remembered)
  }

  const Observer = typeof MutationObserver === 'function' ? MutationObserver : undefined
  if (Observer !== undefined && frameHost !== null && doc.body !== null) {
    observer = new Observer(() => {
      if (disposed || frame !== null) return
      frame = frameHost.requestAnimationFrame(() => {
        frame = null
        try {
          settle()
        } catch {
          // 外壳正拆了又建：这一帧认不出来就等下一帧，不把异常抛进渲染路径。
        }
      })
    })
    observer.observe(doc.body, { childList: true, subtree: true })
  }

  settle()

  const teardown = (): void => {
    disposed = true
    if (observer !== null) observer.disconnect()
    if (frame !== null && frameHost !== null) {
      frameHost.cancelAnimationFrame(frame)
      frame = null
    }
    button.remove()
    entryStates.delete(doc)
    const style = doc.getElementById(STYLE_ID)
    if (style !== null) style.remove()
    if (mountedEntries.get(doc) === teardown) mountedEntries.delete(doc)
  }
  mountedEntries.set(doc, teardown)
  return teardown
}

/**
 * 更新入口的视觉状态；没有按钮时安静地什么都不做。
 *
 * 没更新时整颗收起来（用户要求：平时不占位置）；但只在「查明确实没有更新」时收，
 * known === false（查询失败）保持可见——否则一次网络抽风就会让面板永远打不开。
 */
export function setEntryState(doc: Document, state: EntryState): void {
  entryStates.set(doc, state)
  for (const entry of Array.from(doc.querySelectorAll<HTMLElement>(`[${MARK}]`))) {
    paintEntry(entry, state)
  }
}

/** 把一份状态画到一颗按钮上：可见性 + 两个属性，别处不再重复这套判断。 */
function paintEntry(entry: HTMLElement, state: EntryState): void {
  const visible = state.hasUpdate || state.busy || state.known === false
  entry.hidden = !visible
  if (state.hasUpdate) entry.setAttribute('data-has-update', '1')
  else entry.removeAttribute('data-has-update')
  if (state.busy) entry.setAttribute('data-busy', '1')
  else entry.removeAttribute('data-busy')
}
