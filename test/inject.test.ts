// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MARK, mountFooterEntry, setEntryState } from '../src/client/inject'

const STYLE_ID = 'dshu-entry-style'

/** 等外壳的下一帧：我们的观察器把 DOM 变更合并到 requestAnimationFrame。 */
function nextFrame(doc: Document): Promise<void> {
  return new Promise((resolve) => {
    const view = doc.defaultView
    if (view !== null && typeof view.requestAnimationFrame === 'function') {
      view.requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 16)
    }
  })
}

async function settle(doc: Document, frames = 4): Promise<void> {
  for (let i = 0; i < frames; i += 1) await nextFrame(doc)
}

function entryNodes(): Element[] {
  return Array.from(document.querySelectorAll(`[${MARK}]`))
}

const cleanups: Array<() => void> = []

/** 所有挂载都登记在这里：测试断言失败时 afterEach 也能把观察器收干净。 */
function mountEntry(doc: Document, hooks: { onOpen(): void }): () => void {
  const unmount = mountFooterEntry(doc, hooks)
  cleanups.push(unmount)
  return unmount
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  for (const node of entryNodes()) node.remove()
  document.getElementById(STYLE_ID)?.remove()
  document.body.innerHTML = ''
})

describe('mountFooterEntry 的三级退路', () => {
  test('有 data-dshm-footer-group 时插在它后面', () => {
    document.body.innerHTML = `
      <div data-slot="sidebar.settings">
        <div class="footer-row">
          <div data-slot="settings.launcher"></div>
          <span data-dshm-footer-group class="dshm_footerGroup">
            <span data-dshm-mobile-web></span>
          </span>
        </div>
      </div>
      <div data-slot="sidebar.footer.action"></div>
    `

    const unmount = mountEntry(document, { onOpen: () => {} })

    const group = document.querySelector('[data-dshm-footer-group]')
    expect(group).not.toBeNull()
    const entry = group?.nextElementSibling
    expect(entry).not.toBeNull()
    expect(entry?.tagName).toBe('BUTTON')
    expect(entry?.classList.contains('dshu-entry')).toBe(true)
    expect(entry?.getAttribute(MARK)).not.toBeNull()
    expect(entry?.parentElement).toBe(group?.parentElement)
    expect(entry?.querySelector('.dshu-dot')).not.toBeNull()

    unmount()
  })

  test('没有 group 时放进 sidebar.footer.action 的末尾', () => {
    document.body.innerHTML = `
      <div data-slot="sidebar.settings">
        <div class="footer-row">
          <div data-slot="settings.launcher"></div>
        </div>
      </div>
      <div data-slot="sidebar.footer.action"><span class="slot-sibling"></span></div>
    `

    const unmount = mountEntry(document, { onOpen: () => {} })

    const slot = document.querySelector('[data-slot="sidebar.footer.action"]')
    const entries = entryNodes()
    expect(entries).toHaveLength(1)
    expect(slot?.lastElementChild).toBe(entries[0])
    expect(entries[0]?.classList.contains('dshu-entry')).toBe(true)

    unmount()
  })

  test('只有 settings.launcher 时追加到它所在那一行末尾', () => {
    document.body.innerHTML = `
      <div data-slot="sidebar.settings">
        <div class="footer-row">
          <div data-slot="settings.launcher"></div>
          <span class="status-hint"></span>
        </div>
      </div>
    `

    const unmount = mountEntry(document, { onOpen: () => {} })

    const launcher = document.querySelector('[data-slot="settings.launcher"]')
    const row = launcher?.parentElement
    const entries = entryNodes()
    expect(entries).toHaveLength(1)
    expect(row?.lastElementChild).toBe(entries[0])
    expect(entries[0]?.classList.contains('dshu-entry')).toBe(true)

    unmount()
  })

  test('三处都没有时不抛错也不画按钮（外壳可能正在渲染）', () => {
    document.body.innerHTML = '<div class="shell"><main></main></div>'

    // 挂载本身不抛错由这一行是否抛出来证明；三处都没有就不该留下按钮。
    const unmount = mountEntry(document, { onOpen: () => {} })
    expect(entryNodes()).toHaveLength(0)
    unmount()
  })
})

describe('外壳重渲染后的补挂', () => {
  test('整行被清空再重建后，按钮回到 group 后面，页面上只有一个', async () => {
    document.body.innerHTML = `
      <div id="footer">
        <div data-slot="sidebar.settings">
          <div class="footer-row">
            <div data-slot="settings.launcher"></div>
            <span data-dshm-footer-group></span>
          </div>
        </div>
      </div>
    `

    const unmount = mountEntry(document, { onOpen: () => {} })
    await settle(document)
    expect(entryNodes()).toHaveLength(1)

    const footer = document.getElementById('footer')
    expect(footer).not.toBeNull()

    // 外壳把这一行整棵丢掉：入口跟着掉线，观察器要能等到新的缝。
    if (footer !== null) footer.innerHTML = ''
    await settle(document)
    expect(entryNodes()).toHaveLength(0)

    // 外壳重新渲染出同样的行，入口要自己补回来。
    if (footer !== null) {
      footer.innerHTML = `
        <div data-slot="sidebar.settings">
          <div class="footer-row">
            <div data-slot="settings.launcher"></div>
            <span data-dshm-footer-group></span>
          </div>
        </div>
      `
    }
    await settle(document)

    const entries = entryNodes()
    expect(entries).toHaveLength(1)
    const group = document.querySelector('[data-dshm-footer-group]')
    expect(group?.nextElementSibling).toBe(entries[0])

    unmount()
  })

  test('座位比状态晚到时，按钮一挂上就带着记着的状态（没更新就收起）', async () => {
    // 外壳先返回了骨架，底栏还没画出来：此刻没有座位。
    document.body.innerHTML = '<div id="footer"></div>'
    const unmount = mountEntry(document, { onOpen: () => {} })
    await settle(document)
    expect(entryNodes()).toHaveLength(0)

    // 静默查询先回来了：查明确实没有更新。
    setEntryState(document, { hasUpdate: false, busy: false })

    // 外壳这时才把底栏画出来。
    document.body.innerHTML = `
      <div id="footer">
        <div data-slot="sidebar.settings">
          <div class="footer-row">
            <div data-slot="settings.launcher"></div>
            <span data-dshm-footer-group></span>
          </div>
        </div>
      </div>
    `
    await settle(document)

    const entries = entryNodes()
    expect(entries).toHaveLength(1)
    // 晚到的那一颗不能以默认可见的样子留在底栏。
    expect((entries[0] as HTMLElement).hidden).toBe(true)

    unmount()
  })

  test('外壳重建那一行后，补回来的按钮仍然带着上次的状态', async () => {
    document.body.innerHTML = `
      <div id="footer">
        <div data-slot="sidebar.settings">
          <div class="footer-row">
            <div data-slot="settings.launcher"></div>
            <span data-dshm-footer-group></span>
          </div>
        </div>
      </div>
    `
    const unmount = mountEntry(document, { onOpen: () => {} })
    await settle(document)
    setEntryState(document, { hasUpdate: true, busy: false })
    const before = entryNodes()[0] as HTMLElement | undefined
    expect(before?.hidden).toBe(false)
    expect(before?.getAttribute('data-has-update')).toBe('1')

    // 外壳把这一行整棵丢掉又重建：入口被摘下来，再补回去。
    document.body.innerHTML = `
      <div id="footer">
        <div data-slot="sidebar.settings">
          <div class="footer-row">
            <div data-slot="settings.launcher"></div>
            <span data-dshm-footer-group></span>
          </div>
        </div>
      </div>
    `
    await settle(document)

    const after = entryNodes()[0] as HTMLElement | undefined
    expect(after).toBeDefined()
    expect(after?.getAttribute('data-has-update')).toBe('1')
    expect(after?.hidden).toBe(false)

    unmount()
  })

  test('挂上之后观察器不再自我触发', async () => {
    document.body.innerHTML = `
      <div data-slot="sidebar.settings">
        <div class="footer-row">
          <div data-slot="settings.launcher"></div>
          <span data-dshm-footer-group></span>
        </div>
      </div>
    `

    const unmount = mountEntry(document, { onOpen: () => {} })
    await settle(document)

    // 自己的插入已经落定；之后的帧里不应该再有 DOM 写入，否则观察器会永远空转。
    const records: MutationRecord[] = []
    const probe = new MutationObserver((batch) => records.push(...batch))
    probe.observe(document.body, { childList: true, subtree: true })

    await settle(document, 4)
    probe.disconnect()

    expect(records).toHaveLength(0)

    unmount()
  })
})

describe('交互与状态', () => {
  test('点击调用一次 onOpen', () => {
    document.body.innerHTML = `
      <div data-slot="sidebar.settings">
        <div class="footer-row">
          <div data-slot="settings.launcher"></div>
          <span data-dshm-footer-group></span>
        </div>
      </div>
    `
    const onOpen = vi.fn()
    const unmount = mountEntry(document, { onOpen })

    const entry = entryNodes()[0] as HTMLElement | undefined
    expect(entry).toBeDefined()
    entry?.click()

    expect(onOpen).toHaveBeenCalledTimes(1)

    unmount()
  })

  test('setEntryState 挂载角标与忙碌态，取消更新后属性消失', () => {
    document.body.innerHTML = `
      <div data-slot="sidebar.settings">
        <div class="footer-row">
          <div data-slot="settings.launcher"></div>
          <span data-dshm-footer-group></span>
        </div>
      </div>
    `
    const unmount = mountEntry(document, { onOpen: () => {} })
    const entry = entryNodes()[0]
    expect(entry).toBeDefined()

    setEntryState(document, { hasUpdate: true, busy: true })
    expect(entry?.getAttribute('data-has-update')).toBe('1')
    expect(entry?.getAttribute('data-busy')).toBe('1')

    setEntryState(document, { hasUpdate: false, busy: false })
    expect(entry?.hasAttribute('data-has-update')).toBe(false)
    expect(entry?.hasAttribute('data-busy')).toBe(false)

    unmount()
  })

  test('没更新时入口整颗收起，查询失败时保持可见', () => {
    document.body.innerHTML = `
      <div data-slot="sidebar.settings">
        <div class="footer-row">
          <div data-slot="settings.launcher"></div>
          <span data-dshm-footer-group></span>
        </div>
      </div>
    `
    const unmount = mountEntry(document, { onOpen: () => {} })
    const entry = entryNodes()[0] as HTMLElement | undefined
    expect(entry).toBeDefined()

    // 查明确实没有更新：收起，底栏不留位置。
    setEntryState(document, { hasUpdate: false, busy: false })
    expect(entry?.hidden).toBe(true)

    // 查询失败（known:false）：不知道有没有更新，保持可见，别把面板锁死。
    setEntryState(document, { hasUpdate: false, busy: false, known: false })
    expect(entry?.hidden).toBe(false)
    expect(entry?.hasAttribute('data-has-update')).toBe(false)

    setEntryState(document, { hasUpdate: true, busy: false })
    expect(entry?.hidden).toBe(false)

    // 忙态也保持可见：升级中途入口不能凭空消失。
    setEntryState(document, { hasUpdate: false, busy: true })
    expect(entry?.hidden).toBe(false)

    unmount()
  })
})

describe('卸载', () => {
  test('移除节点、样式与观察器，之后 DOM 变化不再补挂', async () => {
    document.body.innerHTML = `
      <div data-slot="sidebar.settings">
        <div class="footer-row">
          <div data-slot="settings.launcher"></div>
          <span data-dshm-footer-group></span>
        </div>
      </div>
    `

    const unmount = mountEntry(document, { onOpen: () => {} })
    await settle(document)
    expect(entryNodes()).toHaveLength(1)
    expect(document.getElementById(STYLE_ID)).not.toBeNull()

    unmount()

    expect(entryNodes()).toHaveLength(0)
    expect(document.getElementById(STYLE_ID)).toBeNull()

    // 观察器必须已断开：外壳再变，也不该把按钮补回来。
    document.body.innerHTML = `
      <div data-slot="sidebar.settings">
        <div class="footer-row">
          <div data-slot="settings.launcher"></div>
          <span data-dshm-footer-group></span>
        </div>
      </div>
    `
    await settle(document, 3)
    expect(entryNodes()).toHaveLength(0)
  })
})
