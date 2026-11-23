/**
 * 升级面板：本体与插件两段、更新内容折叠、升级进度（NDJSON）。
 *
 * 面板只负责“看见”和“发起”，不自己判断版本：目标版本、被拦原因全来自
 * GET /dsh-upgrade/api/status；升级过程由 POST /dsh-upgrade/api/upgrade 一条
 * NDJSON 流推进；结束之后如果页面里还装着 dsh-restart，就顺手走“预检 → 重启”，
 * 否则降级成“已升级，需手动重启”。
 *
 * 所有请求都带 x-dsh-upgrade: 1（服务端的来源门要求）；dsh-restart 的两个
 * 写端点带它自己的 x-dsh-restart: 1。面板自身不抛异常：任何失败都画成
 * .dshu-error 红条或 .dshu-notice 提示。
 */

import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STALLED_WAIT_MS,
  runBatch,
  type BatchItem,
  type BatchSummary,
} from './batch'
import { fetchPluginUpdates, type PluginUpdate, type PluginUpdates } from './market'

export type PanelState = {
  hasUpdate: boolean
  busy: boolean
}

export type PanelOptions = {
  /** origin 或部署前缀；默认同源。 */
  apiBase?: string
  /** 插件升级的轮询间隔（毫秒）；测试里调小。 */
  pollIntervalMs?: number
  /**
   * 操作没有任何推进（状态、百分比、pnpm 输出都不变）多久就停止等待并解锁按钮。
   * 市场上一个操作可能卡在「等运行中的会话结束」，没人来就不会自己往前走；
   * 这里不无限期把按钮钉死。
   */
  stalledWaitMs?: number
  /** 面板算出的底栏角标状态；没有入口时什么都不发生。 */
  onState?(state: PanelState): void
  /** 面板关闭后回调。 */
  onClose?(): void
}

const PANEL_MARK = 'data-dshu-panel'
const STYLE_ID = 'dshu-panel-style'

const STATUS_PATH = '/dsh-upgrade/api/status'
const CHECK_PATH = '/dsh-upgrade/api/check'
const RELEASES_PATH = '/dsh-upgrade/api/releases'
const UPGRADE_PATH = '/dsh-upgrade/api/upgrade'

const RESTART_STATUS_PATH = '/dsh-restart/api/status'
const RESTART_PRECHECK_PATH = '/dsh-restart/api/precheck'
const RESTART_PATH = '/dsh-restart/api/restart'

const HOST_HEADERS: Record<string, string> = { 'x-dsh-upgrade': '1' }
const RESTART_HEADERS: Record<string, string> = { 'x-dsh-restart': '1' }

/** dsh-restart 预检的阶段名 → 人话；未知阶段原样显示，不吞信息。 */
const RESTART_STAGE_LABELS: Record<string, string> = {
  config: '配置检查',
  compat: '插件兼容检查',
  boot: '启动冒烟检查',
}

const RELEASE_PAGE = 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v'

const PHASE_LABELS: Record<string, string> = {
  backup: '备份',
  precheck: '预检',
  install: '安装',
  verify: '校验',
  restart: '重启',
  done: '完成',
  fail: '失败',
  rollback: '回滚',
}

/** 本体进度条按这个顺序折算百分比；直接取 PHASE_LABELS 的顺序，避免两处清单漂移。 */
const HOST_PHASES: readonly string[] = Object.keys(PHASE_LABELS).filter(
  (phase) => phase !== 'fail' && phase !== 'rollback',
)

const STYLE_TEXT = [
  '.dshu-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.32)}',
  '.dshu-panel{position:relative;display:flex;flex-direction:column;gap:0;width:min(560px,100%);max-height:min(80vh,720px);overflow:hidden;padding:0;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-primary,#fff));color:var(--dsw-alias-label-primary,inherit);box-shadow:0 18px 48px rgba(0,0,0,.24);font:14px/1.55 var(--dsw-font-family,system-ui,sans-serif)}',
  // 头部不参与滚动：外壳 overflow:hidden，只有 .dshu-body 滚。
  '.dshu-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
  '.dshu-body{display:flex;flex-direction:column;gap:14px;min-height:0;overflow:auto;padding:14px 20px 20px}',
  '.dshu-title{font-size:16px;font-weight:600}',
  '.dshu-close{flex:none;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer}',
  '.dshu-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
  '.dshu-section{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:var(--dsw-radius-md,8px)}',
  '.dshu-section h3{margin:0;font-size:14px;font-weight:600}',
  '.dshu-versions{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}',
  '.dshu-version{font-variant-numeric:tabular-nums}',
  '.dshu-current{color:var(--dsw-alias-label-secondary,inherit)}',
  '.dshu-arrow{color:var(--dsw-alias-label-tertiary,inherit)}',
  '.dshu-target{font-weight:600;color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
  '.dshu-channel{margin-left:4px;color:var(--dsw-alias-label-tertiary,inherit)}',
  '.dshu-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
  '.dshu-toggle{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}',
  '.dshu-toggle input{accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
  '.dshu-refresh,.dshu-upgrade-btn,.dshu-release-toggle{padding:6px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;cursor:pointer}',
  '.dshu-upgrade-btn{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent;color:#fff;font-weight:600}',
  '.dshu-upgrade-btn:disabled{opacity:.55;cursor:not-allowed}',
  '.dshu-upgrade-btn[data-blocked]{background:transparent;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,inherit);font-weight:400}',
  '.dshu-release{display:flex;flex-direction:column;gap:8px}',
  '.dshu-release[hidden]{display:none}',
  '.dshu-release-row{display:flex;flex-direction:column;gap:6px}',
  '.dshu-release-toggle{align-self:flex-start;font-weight:600}',
  '.dshu-release-body{padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
  '.dshu-release-body[hidden]{display:none}',
  '.dshu-release-items{margin:0;padding-left:18px}',
  '.dshu-release-link{color:var(--dsw-alias-state-business-primary,#4d6bfe);text-decoration:none;font-size:13px}',
  '.dshu-release-hint{display:flex;gap:8px;align-items:center;color:var(--dsw-alias-label-secondary,inherit)}',
  '.dshu-plugin-list{display:flex;flex-direction:column;gap:8px}',
  '.dshu-plugins-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0}',
  '.dshu-plugins-head h3{margin:0}',
  '.dshu-plugins-head .dshu-upgrade-all{margin-left:auto}',
  '.dshu-upgrade-all,.dshu-restart{padding:4px 10px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-family:inherit;cursor:pointer}',
  '.dshu-upgrade-all:disabled{opacity:.5;cursor:default}',
  '.dshu-plugin-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
  '.dshu-plugin-summary[hidden]{display:none}',
  '.dshu-plugin{display:flex;flex-direction:column;gap:4px;padding:10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03))}',
  '.dshu-plugin-line{display:flex;justify-content:space-between;gap:10px;align-items:baseline}',
  '.dshu-plugin-name{font-weight:600;overflow:hidden;text-overflow:ellipsis}',
  '.dshu-plugin-version{color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums}',
  '.dshu-plugin-state{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
  '.dshu-plugin-progress{display:flex;flex-direction:column;gap:4px}',
  '.dshu-plugin-progress[hidden]{display:none}',
  '.dshu-plugin-progress-text{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
  '.dshu-plugin-empty,.dshu-plugin-unavailable{color:var(--dsw-alias-label-secondary,inherit)}',
  '.dshu-plugin-state[data-error]{color:var(--dsw-alias-state-error-primary,#e5484d)}',
  // 进度条：有百分比就定宽，没有就左右来回跑（pnpm 还没给总量）。
  '.dshu-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.1));overflow:hidden}',
  '.dshu-bar[hidden]{display:none}',
  '.dshu-bar-fill{height:100%;width:0;background:var(--dsw-alias-state-business-primary,#4d6bfe);transition:width .25s ease}',
  '.dshu-bar[data-indeterminate] .dshu-bar-fill{width:38%;animation:dshu-slide 1.1s ease-in-out infinite}',
  '@keyframes dshu-slide{0%{margin-left:-38%}100%{margin-left:100%}}',
  '@media (prefers-reduced-motion:reduce){.dshu-bar[data-indeterminate] .dshu-bar-fill{animation:none;margin-left:0;width:100%;opacity:.4}}',
  '.dshu-host-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.1));overflow:hidden}',
  '.dshu-host-bar[hidden]{display:none}',
  '.dshu-host-bar .dshu-bar-fill{height:100%;width:0;background:var(--dsw-alias-state-business-primary,#4d6bfe);transition:width .25s ease}',
  '.dshu-progress{display:flex;flex-direction:column;gap:4px;padding:10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));font-size:13px}',
  '.dshu-progress[hidden]{display:none}',
  '.dshu-progress-line::before{content:"› ";color:var(--dsw-alias-label-tertiary,inherit)}',
  '.dshu-error{padding:10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-state-error-bg,rgba(229,72,77,.12));color:var(--dsw-alias-state-error-primary,#e5484d)}',
  '.dshu-notice{padding:10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-state-business-bg,rgba(77,107,254,.1));font-size:13px}',
  '.dshu-notice[hidden]{display:none}',
].join('\n')

type Survey = {
  current: string
  channels: { latest: string, next: string, alpha: string }
  target: string
  blocked: { code: string, message: string } | null
  includePrerelease: boolean
  /** 盘上已是 current、但进程还在跑旧代码：升级完成过，只差一次重启 */
  restartRequired: boolean
}

type Release = {
  version: string
  channel: string
  publishedAt: string
  items: string[]
  url: string
}

type ReleasesReply = {
  releases: Release[]
  degraded: boolean
}

type View = {
  doc: Document
  options: PanelOptions
  overlay: HTMLElement
  panel: HTMLElement
  /** 头部固定，滚动只发生在这里。 */
  body: HTMLElement
  hostSection: HTMLElement
  pluginsSection: HTMLElement
  hostVersions: HTMLElement
  hostActions: HTMLElement
  releaseBox: HTMLElement
  /** 本体升级的阶段进度条；没有升级时整个隐藏。 */
  hostBar: HTMLElement
  hostFill: HTMLElement
  pluginHead: HTMLElement
  pluginList: HTMLElement
  /** 批量事件按名字找回自己那一行；重画列表时整张表重建。 */
  rows: Map<string, PluginRowView>
  upgradeAllButton: HTMLButtonElement
  /** Task 4 接线；这里只把位置占好，平时藏着。 */
  restartButton: HTMLButtonElement
  /** 第一次点「重启 DSH」只进入确认态，第二次才真的预检并重启。 */
  restartArmed: boolean
  pluginSummary: HTMLElement
  progress: HTMLElement
  notice: HTMLElement
  prerelease: HTMLInputElement
  refreshButton: HTMLButtonElement
  upgradeButton: HTMLButtonElement | null
  error: HTMLElement | null
  survey: Survey | null
  plugins: PluginUpdates | null
  includePrerelease: boolean
  upgradeBusy: boolean
  batchBusy: boolean
  token: number
  closed: boolean
  previousOverflow: string
  focusBefore: Element | null
  onKeydown: (event: KeyboardEvent) => void
}

/** 同一文档只允许一个面板；位置在 openPanel 里同步占住，避免连点叠两层。 */
const activeViews = new WeakMap<Document, View>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** base 是 origin 或部署前缀；路径常量自带 /dsh-xxx，不能再补一次。 */
function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

/** 浏览器的 fetch 必须绑在全局上；测试里 globalThis.fetch 是假实现。 */
function fetchOf(doc: Document): typeof fetch {
  const globalCandidate: unknown = (globalThis as { fetch?: unknown }).fetch
  if (typeof globalCandidate === 'function') {
    return (globalCandidate as typeof fetch).bind(globalThis)
  }
  const view = doc.defaultView
  if (view !== null && typeof view.fetch === 'function') {
    return view.fetch.bind(view) as typeof fetch
  }
  return (async () => {
    throw new Error('当前环境没有 fetch')
  }) as unknown as typeof fetch
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  doc.head.appendChild(style)
}

function element(doc: Document, tag: string, className: string, text?: string): HTMLElement {
  const node = doc.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function buttonOf(doc: Document, className: string, text: string): HTMLButtonElement {
  const node = doc.createElement('button')
  node.type = 'button'
  node.className = className
  node.textContent = text
  return node
}

function live(view: View, token: number): boolean {
  return !view.closed && view.token === token
}

function hasNewerTarget(survey: Survey | null): boolean {
  return survey !== null && survey.target !== '' && survey.target !== survey.current
}

/** 有更新，或升级装完还没重启——两种状态都要让入口角标亮着。 */
function hasHostUpdate(survey: Survey | null): boolean {
  return hasNewerTarget(survey) || (survey !== null && survey.restartRequired)
}

function normalizeSurvey(value: unknown): Survey | null {
  if (!isRecord(value)) return null
  const current = asString(value.current)
  if (current === '') return null
  const channelsRaw = isRecord(value.channels) ? value.channels : {}
  const blockedRaw = isRecord(value.blocked) ? value.blocked : null
  return {
    current,
    channels: {
      latest: asString(channelsRaw.latest),
      next: asString(channelsRaw.next),
      alpha: asString(channelsRaw.alpha),
    },
    target: asStringOrNull(value.target) ?? '',
    blocked:
      blockedRaw === null
        ? null
        : { code: asString(blockedRaw.code), message: asString(blockedRaw.message) },
    includePrerelease: value.includePrerelease === true,
    restartRequired: value.restartRequired === true,
  }
}

function normalizeReleases(value: unknown): ReleasesReply {
  if (!isRecord(value)) return { releases: [], degraded: true }
  const degraded = value.degraded === true
  const list: Release[] = []
  if (Array.isArray(value.releases)) {
    for (const entry of value.releases) {
      if (!isRecord(entry)) continue
      const version = asString(entry.version)
      if (version === '') continue
      const items: string[] = []
      if (Array.isArray(entry.items)) {
        for (const item of entry.items) {
          if (typeof item === 'string' && item !== '') items.push(item)
        }
      }
      list.push({
        version,
        channel: asString(entry.channel),
        publishedAt: asString(entry.publishedAt),
        items,
        url: asString(entry.url),
      })
    }
  }
  return { releases: list, degraded }
}

function channelOf(survey: Survey, version: string): string {
  if (survey.channels.alpha !== '' && survey.channels.alpha === version) return 'alpha'
  if (survey.channels.next !== '' && survey.channels.next === version) return 'next'
  if (survey.channels.latest !== '' && survey.channels.latest === version) return 'latest'
  return ''
}

function releaseTitle(release: Release): string {
  const parts = ['v' + release.version]
  if (release.channel !== '') parts.push(release.channel)
  if (release.publishedAt !== '') parts.push(release.publishedAt.slice(0, 10))
  return parts.join(' · ')
}

function phaseLabel(phase: string): string {
  const label = PHASE_LABELS[phase]
  return label === undefined ? (phase === '' ? '进行中' : phase) : label
}

function errorTextOf(value: unknown): string {
  if (typeof value === 'string' && value !== '') return value
  if (isRecord(value)) {
    const message = asString(value.message)
    if (message !== '') return message
    const code = asString(value.code)
    if (code !== '') return code
  }
  return '升级失败'
}

function failureTextOf(event: Record<string, unknown>): string {
  if (event.error !== undefined && event.error !== null) return errorTextOf(event.error)
  const message = asString(event.message)
  return message !== '' ? message : '升级失败'
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

type JsonReply = { ok: boolean, status: number, body: unknown }

async function requestJson(f: typeof fetch, url: string, init?: RequestInit): Promise<JsonReply> {
  const response = await f(url, init)
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { ok: response.ok, status: response.status, body }
}

type StreamReader = {
  read(): Promise<{ done: boolean, value?: Uint8Array }>
}

type StreamBody = {
  getReader(): StreamReader
}

function drainLines(buffer: string, onLine: (line: string) => void): string {
  let rest = buffer
  for (;;) {
    const index = rest.indexOf('\n')
    if (index < 0) return rest
    const line = rest.slice(0, index).trim()
    rest = rest.slice(index + 1)
    if (line !== '') onLine(line)
  }
}

function emitLine(line: string, sink: (event: Record<string, unknown>) => void): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (isRecord(parsed)) sink(parsed)
}

/**
 * 逐行读 NDJSON。真浏览器里 response.body 一定有 getReader；jsdom 的假响应
 * 没有 body，退回 text() 再按换行拆——否则进度一条都读不到。
 */
async function readNdjson(response: Response, sink: (event: Record<string, unknown>) => void): Promise<void> {
  const stream: unknown = response.body
  const readerHost =
    stream !== null && typeof stream === 'object' && 'getReader' in stream
      ? (stream as StreamBody)
      : null
  if (readerHost !== null && typeof readerHost.getReader === 'function') {
    const reader = readerHost.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.value !== undefined) buffer += decoder.decode(chunk.value, { stream: true })
      buffer = drainLines(buffer, (line) => {
        emitLine(line, sink)
      })
      if (chunk.done === true) break
    }
    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail !== '') emitLine(tail, sink)
    return
  }

  const text = await response.text()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') emitLine(trimmed, sink)
  }
}

function buildView(doc: Document, options: PanelOptions): View {
  ensureStyle(doc)

  const overlay = element(doc, 'div', 'dshu-overlay')
  overlay.setAttribute(PANEL_MARK, '')
  const panel = element(doc, 'div', 'dshu-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', 'DSH 升级')

  const head = element(doc, 'div', 'dshu-head')
  const title = element(doc, 'span', 'dshu-title', 'DSH 升级')
  const closeButton = buttonOf(doc, 'dshu-close', '×')
  closeButton.setAttribute('aria-label', '关闭')
  head.append(title, closeButton)

  const hostSection = element(doc, 'section', 'dshu-section')
  hostSection.setAttribute('data-k', 'host')
  const hostTitle = doc.createElement('h3')
  hostTitle.textContent = '本体'
  const hostVersions = element(doc, 'div', 'dshu-versions')
  const hostActions = element(doc, 'div', 'dshu-host-actions')
  const hostBar = element(doc, 'div', 'dshu-host-bar')
  hostBar.hidden = true
  const hostFill = element(doc, 'div', 'dshu-bar-fill')
  hostBar.appendChild(hostFill)
  const releaseBox = element(doc, 'div', 'dshu-release')
  releaseBox.hidden = true
  const hostRow = element(doc, 'div', 'dshu-row')
  const toggleLabel = element(doc, 'label', 'dshu-toggle')
  const prerelease = doc.createElement('input')
  prerelease.type = 'checkbox'
  prerelease.className = 'dshu-prerelease'
  toggleLabel.append(prerelease, doc.createTextNode('显示预发布版本'))
  const refreshButton = buttonOf(doc, 'dshu-refresh', '重新检查')
  hostRow.append(toggleLabel, refreshButton)
  hostSection.append(hostTitle, hostVersions, hostBar, hostActions, releaseBox, hostRow)

  const pluginsSection = element(doc, 'section', 'dshu-section')
  pluginsSection.setAttribute('data-k', 'plugins')
  // 标题与动作同一行：左边「插件（N 个可更新）」，右边「全部升级」；重启按钮 Task 4 才露头。
  const pluginsHead = element(doc, 'div', 'dshu-plugins-head')
  const pluginHead = doc.createElement('h3')
  pluginHead.className = 'dshu-plugin-head'
  pluginHead.textContent = '插件'
  const upgradeAllButton = buttonOf(doc, 'dshu-upgrade-all', '全部升级')
  const restartButton = buttonOf(doc, 'dshu-restart', '重启 DSH')
  restartButton.hidden = true
  pluginsHead.append(pluginHead, upgradeAllButton, restartButton)
  const pluginList = element(doc, 'div', 'dshu-plugin-list')
  const pluginSummary = element(doc, 'div', 'dshu-plugin-summary')
  pluginSummary.hidden = true
  pluginsSection.append(pluginsHead, pluginList, pluginSummary)

  const progress = element(doc, 'div', 'dshu-progress')
  progress.hidden = true
  const notice = element(doc, 'div', 'dshu-notice')
  notice.hidden = true

  // 头部独立于滚动区：面板自己不滚，只有 body 滚，标题与关闭按钮永远在原位。
  const body = element(doc, 'div', 'dshu-body')
  body.append(hostSection, pluginsSection, progress, notice)
  panel.append(head, body)
  overlay.appendChild(panel)

  const view: View = {
    doc,
    options,
    overlay,
    panel,
    body,
    hostSection,
    pluginsSection,
    hostVersions,
    hostActions,
    releaseBox,
    hostBar,
    hostFill,
    pluginHead,
    pluginList,
    rows: new Map<string, PluginRowView>(),
    upgradeAllButton,
    restartButton,
    restartArmed: false,
    pluginSummary,
    progress,
    notice,
    prerelease,
    refreshButton,
    upgradeButton: null,
    error: null,
    survey: null,
    plugins: null,
    includePrerelease: false,
    upgradeBusy: false,
    batchBusy: false,
    token: 1,
    closed: false,
    previousOverflow: '',
    focusBefore: doc.activeElement,
    onKeydown: () => {},
  }

  view.onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close(view)
  }
  closeButton.addEventListener('click', () => {
    close(view)
  })
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close(view)
  })
  upgradeAllButton.addEventListener('click', () => {
    void startBatch(view)
  })
  restartButton.addEventListener('click', () => {
    // 重启会直接掐断正在跑的会话：第一下只把危险摆到明面上，第二下才发请求。
    if (view.batchBusy || view.upgradeBusy || restartButton.disabled) return
    if (!view.restartArmed) {
      view.restartArmed = true
      restartButton.textContent = '确认重启？'
      setNotice(view, '重启会中断当前会话；再点一次「确认重启？」继续')
      return
    }
    view.restartArmed = false
    restartButton.textContent = '重启中…'
    restartButton.disabled = true
    // 插件批量没有本体升级的阶段条；清掉上一轮残留，让预检从干净的面板开始。
    view.progress.textContent = ''
    view.progress.hidden = true
    const token = view.token
    void runRestartChain(view, token, (reason) => {
      if (!live(view, token)) return
      restartButton.disabled = false
      restartButton.textContent = '重启 DSH'
      setNotice(view, '重启不可用：' + reason)
    })
  })
  prerelease.addEventListener('change', () => {
    // 升级进行中重查会用旧 survey 重画，按钮忽隐忽现且点击无效果；直接按住。
    if (view.upgradeBusy || view.batchBusy) return
    const token = view.token
    view.includePrerelease = prerelease.checked
    void loadHost(view, token, { check: true, force: false })
  })
  refreshButton.addEventListener('click', () => {
    if (view.upgradeBusy || view.batchBusy) return
    const token = view.token
    view.includePrerelease = prerelease.checked
    void loadHost(view, token, { check: true, force: true })
  })

  return view
}

function close(view: View): void {
  if (view.closed) return
  view.closed = true
  view.token += 1
  view.doc.removeEventListener('keydown', view.onKeydown)
  view.overlay.remove()
  view.doc.body.style.overflow = view.previousOverflow
  if (activeViews.get(view.doc) === view) activeViews.delete(view.doc)
  if (lastView === view) lastView = null
  const focusBefore = view.focusBefore
  if (
    focusBefore !== null &&
    typeof (focusBefore as HTMLElement).focus === 'function' &&
    focusBefore.isConnected
  ) {
    try {
      ;(focusBefore as HTMLElement).focus()
    } catch {
      // 焦点还回去失败不算错误：面板已经关掉了。
    }
  }
  try {
    view.options.onClose?.()
  } catch {
    // 收尾回调自己的异常不该冒到调用方。
  }
}

/** WeakMap 不迭代，另记一份最近打开的视图供无参 closePanel() 收尾。 */
let lastView: View | null = null

/** 关闭当前面板；doc 给定时只关这个文档里的。 */
export function closePanel(doc?: Document): void {
  const view = doc === undefined ? lastView : (activeViews.get(doc) ?? null)
  if (view !== null) close(view)
}

function emitState(view: View): void {
  const hostUpdate = hasHostUpdate(view.survey)
  const pluginUpdate =
    view.plugins !== null && view.plugins.available && view.plugins.updatable.length > 0
  try {
    view.options.onState?.({ hasUpdate: hostUpdate || pluginUpdate, busy: view.upgradeBusy || view.batchBusy })
  } catch {
    // 角标刷新失败不影响面板本身。
  }
}

function showError(view: View, text: string): void {
  if (view.error === null) {
    const bar = element(view.doc, 'div', 'dshu-error')
    bar.setAttribute('role', 'alert')
    view.body.insertBefore(bar, view.progress)
    view.error = bar
  }
  view.error.textContent = text
}

function clearError(view: View): void {
  if (view.error === null) return
  view.error.remove()
  view.error = null
}

function setNotice(view: View, text: string): void {
  if (text === '') {
    view.notice.hidden = true
    view.notice.textContent = ''
    return
  }
  view.notice.hidden = false
  view.notice.textContent = text
}

function resetProgress(view: View): void {
  view.progress.textContent = ''
  view.progress.hidden = false
}

function addProgress(view: View, text: string): void {
  view.progress.hidden = false
  const line = element(view.doc, 'div', 'dshu-progress-line', text)
  view.progress.appendChild(line)
}

/** 阶段未知（比如服务端加了新阶段）就画不确定进度，别报一个假百分比。 */
function setHostProgress(view: View, phase: string): void {
  view.hostBar.hidden = false
  const index = HOST_PHASES.indexOf(phase)
  if (index < 0) {
    view.hostBar.setAttribute('data-indeterminate', '')
    view.hostFill.style.width = ''
    return
  }
  view.hostBar.removeAttribute('data-indeterminate')
  view.hostFill.style.width = String(Math.round(((index + 1) / HOST_PHASES.length) * 100)) + '%'
}

function hideHostProgress(view: View): void {
  view.hostBar.hidden = true
  view.hostBar.removeAttribute('data-indeterminate')
  view.hostFill.style.width = '0'
}

function renderSurvey(view: View): void {
  const doc = view.doc
  view.hostVersions.textContent = ''
  view.releaseBox.textContent = ''
  view.releaseBox.hidden = true
  if (view.upgradeButton !== null) {
    view.upgradeButton.remove()
    view.upgradeButton = null
  }

  const survey = view.survey
  if (survey === null) {
    view.hostVersions.appendChild(element(doc, 'span', 'dshu-version', '读不到版本状态'))
    return
  }

  if (survey.restartRequired) {
    // target === current 时不能报「已是最新」：盘上是新的，跑着的进程还是旧的。
    view.hostVersions.appendChild(
      element(
        doc,
        'span',
        'dshu-current dshu-restart-required',
        '已升级到 ' + survey.current + '，需重启 dsh web 才生效',
      ),
    )
  }

  if (!hasNewerTarget(survey)) {
    if (!survey.restartRequired) {
      view.hostVersions.appendChild(
        element(doc, 'span', 'dshu-current', '已是最新（当前 ' + survey.current + '）'),
      )
    }
    return
  }

  const target = survey.target
  view.hostVersions.append(
    element(doc, 'span', 'dshu-version dshu-current', '当前 ' + survey.current),
    element(doc, 'span', 'dshu-arrow', '→'),
    element(doc, 'span', 'dshu-version dshu-target', '目标 ' + target),
  )
  const channel = channelOf(survey, target)
  if (channel !== '') {
    view.hostVersions.appendChild(element(doc, 'span', 'dshu-channel', channel + ' 通道'))
  }

  const upgrade = buttonOf(doc, 'dshu-upgrade-btn', '升级到 ' + target)
  if (survey.blocked !== null) {
    upgrade.disabled = true
    upgrade.setAttribute('data-blocked', '')
    upgrade.textContent = survey.blocked.message !== '' ? survey.blocked.message : '需要 Node（本机版本不满足）'
    upgrade.title = survey.blocked.code
  } else {
    // 状态可能比插件列表晚到：这期间批量已经在跑，按钮必须一开始就是禁用的，
    // 否则会造出一个点下去毫无反应的入口。
    upgrade.disabled = view.batchBusy || view.upgradeBusy
    upgrade.addEventListener('click', () => {
      void runHostUpgrade(view, view.token)
    })
  }
  view.hostActions.appendChild(upgrade)
  view.upgradeButton = upgrade
}

function releaseTagUrl(target: string): string {
  return RELEASE_PAGE + encodeURIComponent(target)
}

/** 发布页链接只认 http(s)：javascript: 之类的 href 不能进 DOM。 */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function renderReleases(view: View, reply: ReleasesReply): void {
  const doc = view.doc
  const box = view.releaseBox
  box.textContent = ''
  const survey = view.survey
  if (survey === null || !hasNewerTarget(survey)) {
    box.hidden = true
    return
  }

  if (reply.degraded) {
    box.hidden = false
    const hint = element(doc, 'div', 'dshu-release-hint', '更新内容拉取失败')
    const link = doc.createElement('a')
    link.className = 'dshu-release-link'
    link.href = releaseTagUrl(survey.target)
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = '去 GitHub 看'
    hint.appendChild(link)
    box.appendChild(hint)
    return
  }

  if (reply.releases.length === 0) {
    box.hidden = true
    return
  }

  box.hidden = false
  for (const [index, release] of reply.releases.entries()) {
    const row = element(doc, 'div', 'dshu-release-row')
    const toggle = buttonOf(doc, 'dshu-release-toggle', releaseTitle(release))
    toggle.setAttribute('aria-expanded', index === 0 ? 'true' : 'false')
    const body = element(doc, 'div', 'dshu-release-body')
    body.hidden = index !== 0
    const list = doc.createElement('ul')
    list.className = 'dshu-release-items'
    if (release.items.length === 0) {
      const item = doc.createElement('li')
      item.textContent = '该版本没有列出更新条目'
      list.appendChild(item)
    }
    for (const text of release.items) {
      const item = doc.createElement('li')
      item.textContent = text
      list.appendChild(item)
    }
    body.appendChild(list)
    if (release.url !== '' && isHttpUrl(release.url)) {
      const link = doc.createElement('a')
      link.className = 'dshu-release-link'
      link.href = release.url
      link.target = '_blank'
      link.rel = 'noreferrer'
      link.textContent = '看这次发布'
      body.appendChild(link)
    }
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden
      toggle.setAttribute('aria-expanded', body.hidden ? 'false' : 'true')
    })
    row.append(toggle, body)
    box.appendChild(row)
  }
}

function renderPlugins(view: View): void {
  const doc = view.doc
  view.pluginList.textContent = ''
  view.rows.clear()
  view.pluginSummary.hidden = true
  view.pluginSummary.textContent = ''
  const plugins = view.plugins
  if (plugins === null) {
    view.pluginHead.textContent = '插件'
    view.upgradeAllButton.hidden = true
    return
  }
  if (!plugins.available) {
    view.pluginHead.textContent = '插件'
    view.upgradeAllButton.hidden = true
    view.pluginList.appendChild(element(doc, 'div', 'dshu-plugin-unavailable', '插件更新不可用'))
    return
  }
  view.pluginHead.textContent =
    plugins.updatable.length > 0 ? '插件（' + plugins.updatable.length + ' 个可更新）' : '插件'
  if (plugins.updatable.length === 0) {
    view.upgradeAllButton.hidden = true
    view.pluginList.appendChild(element(doc, 'div', 'dshu-plugin-empty', '已是最新'))
    return
  }
  view.upgradeAllButton.hidden = false
  for (const update of plugins.updatable) {
    const row = createPluginRow(view, update)
    view.rows.set(update.name, row)
    view.pluginList.appendChild(row.root)
  }
}

/** 一行插件需要的全部节点：状态与失败原因都写在这一行里，不往面板底部抛。 */
export type PluginRowView = {
  root: HTMLElement
  name: HTMLElement
  version: HTMLElement
  state: HTMLElement
  bar: HTMLElement
  fill: HTMLElement
  progress: HTMLElement
  progressText: HTMLElement
}

/**
 * 两行式：第一行名字与版本对，第二行是这一行自己的状态与进度。
 * 不在行内放升级入口——升级由面板顶部的一个「全部升级」串行驱动。
 */
function createPluginRow(view: View, update: PluginUpdate): PluginRowView {
  const doc = view.doc
  const root = element(doc, 'div', 'dshu-plugin')
  root.dataset.name = update.name
  const line = element(doc, 'div', 'dshu-plugin-line')
  const name = element(doc, 'div', 'dshu-plugin-name', update.name)
  const version = element(doc, 'div', 'dshu-plugin-version', update.from + ' → ' + update.to)
  line.append(name, version)
  const state = element(doc, 'div', 'dshu-plugin-state')
  const progress = element(doc, 'div', 'dshu-plugin-progress')
  progress.hidden = true
  const bar = element(doc, 'div', 'dshu-bar')
  bar.hidden = true
  const fill = element(doc, 'div', 'dshu-bar-fill')
  bar.appendChild(fill)
  const progressText = element(doc, 'div', 'dshu-plugin-progress-text')
  progress.append(bar, progressText)
  root.append(line, state, progress)
  return { root, name, version, state, bar, fill, progress, progressText }
}

/** 行内状态：失败用红字，并且清掉上一轮的进度条。 */
function setRowState(row: PluginRowView, text: string, isError = false, full?: string): void {
  row.state.textContent = text
  row.state.title = full ?? ''
  // 没有状态文字时整行收起，免得行与进度块之间留一条空缝。
  row.state.hidden = text === ''
  if (isError) row.state.setAttribute('data-error', '')
  else row.state.removeAttribute('data-error')
}

/**
 * 宿主失败正文常常是几百字的中英双语，用 " / " 拼在一起；行里只留中文首句，
 * 长话截断，全文挂在 title 上——一行红字塞满整个面板反而读不出是哪一步失败。
 */
function compactReason(raw: string, limit = 90): string {
  const zh = raw.split(' / ')[0] ?? raw
  const flat = zh.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  if (flat.length <= limit) return flat
  return flat.slice(0, limit - 1) + '…'
}

/** percent 为 null 表示 pnpm 还没报总量：画不确定进度（来回跑），不假装 0%。 */
function setRowProgress(row: PluginRowView, percent: number | null, visible: boolean): void {
  row.progress.hidden = !visible
  row.bar.hidden = !visible
  if (!visible) {
    row.bar.removeAttribute('data-indeterminate')
    row.fill.style.width = '0'
    return
  }
  if (percent === null) {
    row.bar.setAttribute('data-indeterminate', '')
    row.fill.style.width = ''
    return
  }
  row.bar.removeAttribute('data-indeterminate')
  row.fill.style.width = String(percent) + '%'
}

/**
 * 把一个 BatchItem 画到它自己那一行。
 *
 * 这里只做两件事：把 pnpm 的长 output 压成一句、给真失败上红字。
 * message 与 unavailable 由批量层判定；请求层不可用不是安装失败，不红。
 */
export function paintBatchItem(row: PluginRowView, item: BatchItem): void {
  switch (item.state) {
    case 'pending':
      setRowState(row, '')
      row.progressText.textContent = ''
      setRowProgress(row, null, false)
      return
    case 'running': {
      const percent = item.percent
      // 行内文案按批量层给的优先级：排队提示（message）> pnpm 原话（detail）> 百分比。
      // detail 是 pnpm 的整行输出，压成一句，免得行高忽上忽下。
      setRowState(row, '')
      row.progressText.textContent =
        item.message ??
        (item.detail !== null
          ? compactReason(item.detail)
          : percent !== null
            ? '正在升级…' + String(percent) + '%'
            : '正在升级…')
      setRowProgress(row, percent, true)
      return
    }
    case 'succeeded':
      setRowState(row, '已升级')
      row.progressText.textContent = ''
      setRowProgress(row, null, false)
      return
    case 'failed': {
      row.progressText.textContent = ''
      setRowProgress(row, null, false)
      if (item.unavailable) {
        setRowState(row, item.message ?? '插件更新不可用')
        return
      }
      const message = item.message
      // 批量层的 message 有纯原因与完整句两种：完整句不再补前缀，但同样压成一句、全文进 title。
      const stalled =
        message !== null &&
        (message.startsWith('还没开始升级') ||
          message.startsWith('升级还在后台跑') ||
          message.startsWith('一直在排队'))
      const complete =
        message !== null &&
        (message.startsWith('升级失败') ||
          message.startsWith('已') ||
          message === '插件更新不可用' ||
          stalled)
      const text =
        message === null || message === ''
          ? '升级失败'
          : complete
            ? compactReason(message)
            : '升级失败：' + compactReason(message)
      // 排队/卡住只是没开始，不是安装失败，不上红字。
      setRowState(row, text, !stalled, message ?? undefined)
      return
    }
  }
}

/** R44：batch 对跳过的包不发事件，收尾时按 summary 补一行状态。 */
function paintSkipped(row: PluginRowView): void {
  setRowState(row, '已跳过')
  row.progressText.textContent = ''
  setRowProgress(row, null, false)
}

/** R33：一行里把「升成几个、败几个、跳几个」说清；为 0 的那段不写。 */
function batchSummaryText(summary: BatchSummary): string {
  const parts: string[] = []
  if (summary.succeeded.length > 0) parts.push(String(summary.succeeded.length) + ' 个已升级')
  if (summary.failed.length > 0) parts.push(String(summary.failed.length) + ' 个失败')
  if (summary.skipped.length > 0) parts.push(String(summary.skipped.length) + ' 个跳过')
  if (summary.restartRequired && summary.succeeded.length > 0) parts.push('需重启生效')
  return parts.join('，')
}

/** 本体按钮该不该禁用：无更新、被阻塞，或任一侧正忙。 */
function hostUpgradeDisabled(view: View): boolean {
  return (
    view.survey === null ||
    view.survey.blocked !== null ||
    !hasNewerTarget(view.survey) ||
    view.batchBusy ||
    view.upgradeBusy
  )
}

/** 批量忙时按住所有会重画或并发起升级的入口；本体忙时反过来按住「全部升级」。 */
function setBatchBusy(view: View, busy: boolean): void {
  view.batchBusy = busy
  view.upgradeAllButton.disabled = busy || view.upgradeBusy
  view.upgradeAllButton.textContent = busy ? '升级中…' : '全部升级'
  view.prerelease.disabled = busy || view.upgradeBusy
  view.refreshButton.disabled = busy || view.upgradeBusy
  if (view.upgradeButton !== null) {
    if (busy) {
      view.upgradeButton.disabled = true
    } else {
      view.upgradeButton.disabled = hostUpgradeDisabled(view)
    }
  }
  emitState(view)
}

/**
 * 「全部升级」：先把每行清成 pending（上一轮的结果不能留在屏幕上），再串行跑。
 * 事件只改对应名字的那一行；面板关了就停手，剩下的包由 runBatch 记成 skipped。
 */
async function startBatch(view: View): Promise<void> {
  if (view.batchBusy || view.upgradeBusy) return
  const plugins = view.plugins
  if (plugins === null || !plugins.available || plugins.updatable.length === 0) return
  const names = plugins.updatable.map((update) => update.name)
  const token = view.token
  for (const [name, row] of view.rows) {
    paintBatchItem(row, { name, state: 'pending', percent: null, detail: null, message: null, unavailable: false })
  }
  setBatchBusy(view, true)
  view.pluginSummary.hidden = true
  view.pluginSummary.textContent = ''
  // 上一轮露出来的重启入口先收回去；这一轮跑完再按 dsh-restart 的可用性决定。
  view.restartButton.hidden = true
  view.restartButton.disabled = false
  view.restartButton.textContent = '重启 DSH'
  view.restartArmed = false

  let summary: BatchSummary
  try {
    summary = await runBatch(names, fetchOf(view.doc), view.options.apiBase ?? '', {
      pollIntervalMs: view.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      stalledWaitMs: view.options.stalledWaitMs ?? DEFAULT_STALLED_WAIT_MS,
      cancelled: () => view.closed,
      onEvent: (event) => {
        if (!live(view, token)) return
        const row = view.rows.get(event.item.name)
        if (row !== undefined) paintBatchItem(row, event.item)
      },
    })
  } catch (error) {
    // runBatch 的契约是不抛异常；真抛了也不能把红条甩到底栏——失败原因留在汇总行。
    if (!live(view, token)) return
    setBatchBusy(view, false)
    paintSummary(view, '升级中断：' + (error instanceof Error && error.message !== '' ? error.message : '未知原因'))
    return
  }
  if (!live(view, token)) return
  setBatchBusy(view, false)
  paintSummary(view, batchSummaryText(summary))
  for (const name of summary.skipped) {
    const row = view.rows.get(name)
    if (row !== undefined) paintSkipped(row)
  }
  if (summary.succeeded.length > 0) await offerRestart(view, token)
}

/** 汇总行：空文案就收起，不占一条空缝。 */
function paintSummary(view: View, text: string): void {
  view.pluginSummary.textContent = text
  view.pluginSummary.hidden = text === ''
}

async function loadHost(
  view: View,
  token: number,
  mode: 'status' | { check: boolean, force: boolean },
): Promise<void> {
  const f = fetchOf(view.doc)
  const base = view.options.apiBase ?? ''
  try {
    let reply: JsonReply
    if (mode === 'status') {
      reply = await requestJson(f, joinUrl(base, STATUS_PATH), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { ...HOST_HEADERS },
      })
    } else {
      reply = await requestJson(f, joinUrl(base, CHECK_PATH), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...HOST_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ includePrerelease: view.includePrerelease, force: mode.force }),
      })
    }
    if (!live(view, token)) return
    if (!reply.ok) {
      // 刷新偶尔失败不该把上一份好数据抹掉：角标和升级按钮会跟着凭空消失。
      if (view.survey === null) {
        renderSurvey(view)
        emitState(view)
      }
      showError(view, '读取版本状态失败（HTTP ' + reply.status + '）')
      return
    }
    const survey = normalizeSurvey(reply.body)
    view.survey = survey
    clearError(view)
    renderSurvey(view)
    emitState(view)
    if (!live(view, token)) return
    if (!hasNewerTarget(survey)) return
    const releases = await requestJson(
      f,
      joinUrl(base, RELEASES_PATH) +
        '?from=' +
        encodeURIComponent(survey === null ? '' : survey.current) +
        '&to=' +
        encodeURIComponent(survey === null ? '' : survey.target),
      { method: 'GET', credentials: 'same-origin', headers: { ...HOST_HEADERS } },
    )
    if (!live(view, token)) return
    renderReleases(view, releases.ok ? normalizeReleases(releases.body) : { releases: [], degraded: true })
  } catch {
    if (!live(view, token)) return
    showError(view, '读取版本状态失败，请刷新后重试')
  }
}

async function loadPlugins(view: View, token: number): Promise<void> {
  // 批次进行中重画列表会让 rows 与 names 快照脱节（点击时的名单已经发出去了），
  // 这段窗口里不再接受列表刷新。
  if (view.batchBusy) return
  const base = view.options.apiBase ?? ''
  try {
    const plugins = await fetchPluginUpdates(fetchOf(view.doc), base)
    if (!live(view, token)) return
    view.plugins = plugins
    renderPlugins(view)
    emitState(view)
  } catch {
    if (!live(view, token)) return
    view.plugins = { available: false, updatable: [] }
    renderPlugins(view)
    emitState(view)
  }
}

async function runHostUpgrade(view: View, token: number): Promise<void> {
  const survey = view.survey
  if (survey === null || !hasNewerTarget(survey) || view.upgradeBusy || view.batchBusy) return
  const target = survey.target
  const f = fetchOf(view.doc)
  const base = view.options.apiBase ?? ''

  view.upgradeBusy = true
  if (view.upgradeButton !== null) view.upgradeButton.disabled = true
  view.prerelease.disabled = true
  view.refreshButton.disabled = true
  view.upgradeAllButton.disabled = true
  clearError(view)
  setNotice(view, '')
  resetProgress(view)
  emitState(view)

  try {
    const response = await f(joinUrl(base, UPGRADE_PATH), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...HOST_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ target }),
    })
    if (!live(view, token)) return

    if (!response.ok) {
      const body = await readJsonBody(response)
      if (!live(view, token)) return
      const code = isRecord(body) ? asString(body.code) : ''
      const message = isRecord(body) ? asString(body.message) : ''
      if (response.status === 409 || code === 'BUSY') {
        setNotice(view, message !== '' ? message : '已有一轮升级在进行')
      } else {
        showError(view, message !== '' ? message : '升级请求失败（HTTP ' + response.status + '）')
      }
      finishHostBusy(view)
      return
    }

    await consumeUpgrade(view, token, response, target)
    finishHostBusy(view)
  } catch {
    if (!live(view, token)) return
    showError(view, '升级请求失败，请检查网络后重试')
    finishHostBusy(view)
  }
}

function finishHostBusy(view: View): void {
  // 本体这一轮到此结束（含预检与重启请求），阶段条收起来，剩下的用文字进度说话。
  hideHostProgress(view)
  view.upgradeBusy = false
  view.prerelease.disabled = view.batchBusy
  view.refreshButton.disabled = view.batchBusy
  view.upgradeAllButton.disabled = view.batchBusy
  if (view.upgradeButton !== null) {
    const blocked = view.survey !== null && view.survey.blocked !== null
    view.upgradeButton.disabled = blocked || !hasNewerTarget(view.survey)
  }
  emitState(view)
}

async function consumeUpgrade(view: View, token: number, response: Response, target: string): Promise<void> {
  let sawDone = false
  let failure: string | null = null
  try {
    await readNdjson(response, (event) => {
      if (!live(view, token)) return
      const phase = asString(event.phase)
      const message = asString(event.message)
      if (phase === 'fail' || (event.error !== undefined && event.error !== null)) {
        failure = failureTextOf(event)
        return
      }
      if (event.done === true) sawDone = true
      if (phase !== '') setHostProgress(view, phase)
      if (phase === 'done') {
        addProgress(view, phaseLabel('done'))
        return
      }
      addProgress(view, message !== '' ? phaseLabel(phase) + '：' + message : phaseLabel(phase))
    })
  } catch {
    if (!live(view, token)) return
    hideHostProgress(view)
    showError(view, '升级进度读到一半断了，请刷新后确认结果')
    return
  }
  if (!live(view, token)) return

  if (failure !== null) {
    hideHostProgress(view)
    showError(view, failure)
    return
  }
  if (!sawDone) {
    hideHostProgress(view)
    showError(view, '升级没有正常结束，请刷新后确认结果')
    return
  }

  addProgress(view, '已升级到 ' + target)
  await continueToRestart(view, token, target)
}

/** 预检失败事件里能给人看的原因：阶段名 + 第一条失败说明。 */
function restartFailureDetail(event: Record<string, unknown>): string {
  const stage = asString(event.stage)
  const label = stage === '' ? '' : (RESTART_STAGE_LABELS[stage] ?? stage)
  let message = ''
  if (Array.isArray(event.failures)) {
    for (const failure of event.failures) {
      if (!isRecord(failure)) continue
      message = compactReason(asString(failure.message))
      if (message !== '') break
    }
  }
  if (message === '') message = compactReason(asString(event.message))
  if (message === '') return label
  return label === '' ? message : label + '：' + message
}

/**
 * status → precheck → restart 三步固定顺序；任何一步走不通就交给 onManual 说一句人话，
 * 预检没过时绝不发 restart。成功时按调用方给的文案提示。
 */
async function runRestartChain(
  view: View,
  token: number,
  onManual: (reason: string) => void,
  successText = '正在重启…',
): Promise<void> {
  const f = fetchOf(view.doc)
  const base = view.options.apiBase ?? ''
  setNotice(view, '正在预检…')

  let status: Response
  try {
    status = await f(joinUrl(base, RESTART_STATUS_PATH), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { ...RESTART_HEADERS },
    })
  } catch {
    if (live(view, token)) onManual('没找到 dsh-restart')
    return
  }
  if (!live(view, token)) return
  if (!status.ok) {
    // 只有 404 才意味着插件不在；403/500 是「在，但拒绝/坏了」，不能误导人去装。
    onManual(
      status.status === 404
        ? '没找到 dsh-restart'
        : status.status === 401 || status.status === 403
          ? 'dsh-restart 拒绝访问（HTTP ' + status.status + '）'
          : 'dsh-restart 状态查询失败（HTTP ' + status.status + '）',
    )
    return
  }

  let precheck: Response
  try {
    precheck = await f(joinUrl(base, RESTART_PRECHECK_PATH), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...RESTART_HEADERS },
    })
  } catch {
    if (live(view, token)) onManual('预检请求发不出去')
    return
  }
  if (!live(view, token)) return
  if (!precheck.ok) {
    const body = await readJsonBody(precheck)
    if (!live(view, token)) return
    const message = isRecord(body) ? compactReason(asString(body.message)) : ''
    onManual('预检失败（HTTP ' + precheck.status + (message === '' ? '' : '：' + message) + '）')
    return
  }

  let passed = true
  let detail = ''
  try {
    await readNdjson(precheck, (event) => {
      if (!live(view, token)) return
      if (event.ok === false) {
        passed = false
        if (detail === '') detail = restartFailureDetail(event)
      }
      if (event.error !== undefined && event.error !== null) {
        passed = false
        if (detail === '') {
          detail = compactReason(
            isRecord(event.error) ? asString(event.error.message) : asString(event.error),
          )
        }
      }
      const stage = asString(event.stage)
      if (stage !== '') {
        // 预检会克隆 profile 再起一个冒烟实例，几十秒没反馈像是卡死；把阶段推进度条。
        addProgress(
          view,
          '重启预检：' +
            (RESTART_STAGE_LABELS[stage] ?? stage) +
            (event.ok === false ? '（未通过）' : '（通过）'),
        )
        return
      }
      // 失败事件也带 done；别让进度条写「完成」而下面的通知说没通过。
      if (event.done === true && event.ok !== false && passed) addProgress(view, '重启预检完成')
    })
  } catch {
    if (live(view, token)) onManual('预检读到一半断了')
    return
  }
  if (!live(view, token)) return
  if (!passed) {
    // 原因常驻面板，别让用户只看到一闪而过的红条就去猜哪里坏了。
    onManual('预检没通过' + (detail === '' ? '' : '：' + detail))
    return
  }

  let restart: Response
  try {
    restart = await f(joinUrl(base, RESTART_PATH), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...RESTART_HEADERS },
    })
  } catch {
    if (live(view, token)) onManual('重启请求发不出去')
    return
  }
  if (!live(view, token)) return
  if (restart.status === 409) {
    setNotice(view, '已经有一轮重启在进行，请稍后手动刷新页面确认')
    return
  }
  if (!restart.ok) {
    onManual('重启请求失败（HTTP ' + restart.status + '）')
    return
  }
  setNotice(view, successText)
}

async function continueToRestart(view: View, token: number, target: string): Promise<void> {
  await runRestartChain(
    view,
    token,
    (reason) => {
      setNotice(view, '已升级到 ' + target + '，' + reason + '，需手动重启')
    },
    '已升级到 ' + target + '，正在重启…',
  )
}

/** 批量升级收工后按 dsh-restart 的可用性决定露不露重启入口。 */
async function offerRestart(view: View, token: number): Promise<void> {
  view.restartButton.hidden = true
  view.restartButton.disabled = false
  view.restartButton.textContent = '重启 DSH'
  view.restartArmed = false

  const f = fetchOf(view.doc)
  const base = view.options.apiBase ?? ''
  let status: Response
  try {
    status = await f(joinUrl(base, RESTART_STATUS_PATH), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { ...RESTART_HEADERS },
    })
  } catch {
    // 查询期间用户可能又开了一轮批量：这时的旧答案不能把按钮塞回面板。
    if (!live(view, token) || view.batchBusy) return
    setNotice(view, '插件已升级，需手动重启 dsh web 才生效')
    return
  }
  if (!live(view, token) || view.batchBusy) return
  if (status.status === 200) {
    view.restartButton.hidden = false
    setNotice(view, '插件已升级，可点「重启 DSH」让改动生效')
    return
  }
  if (status.status === 404) {
    setNotice(view, '插件已升级，需手动重启 dsh web 才生效')
    return
  }
  setNotice(view, '插件已升级，但重启不可用（HTTP ' + status.status + '），需手动重启 dsh web')
}

/**
 * 打开面板。同一文档重复调用直接返回，不会叠第二层遮罩。
 * 返回时首屏（本体状态、更新内容、插件列表）已经画完；之后的动作都是异步的。
 */
export async function openPanel(doc: Document, opts: PanelOptions = {}): Promise<void> {
  if (activeViews.get(doc) !== undefined) return
  if (doc.querySelector('[' + PANEL_MARK + ']') !== null) return

  const view = buildView(doc, opts)
  const body = doc.body
  view.previousOverflow = body.style.overflow
  body.style.overflow = 'hidden'
  body.appendChild(view.overlay)
  activeViews.set(doc, view)
  lastView = view
  doc.addEventListener('keydown', view.onKeydown)

  const token = view.token
  emitState(view)
  try {
    await Promise.all([loadHost(view, token, 'status'), loadPlugins(view, token)])
  } catch {
    if (live(view, token)) showError(view, '加载升级信息失败，请刷新后重试')
  }
}

/** 底栏入口只需要一个布尔：本体或插件任一有更新。读不到就当没有。 */
export async function probeHasUpdate(doc: Document, opts: PanelOptions = {}): Promise<boolean> {
  const f = fetchOf(doc)
  const base = opts.apiBase ?? ''
  try {
    const [reply, plugins] = await Promise.all([
      requestJson(f, joinUrl(base, STATUS_PATH), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { ...HOST_HEADERS },
      }).catch(() => null),
      fetchPluginUpdates(f, base).catch(() => null),
    ])
    const survey = reply !== null && reply.ok ? normalizeSurvey(reply.body) : null
    const hostUpdate = hasHostUpdate(survey)
    const pluginUpdate =
      plugins !== null && plugins.available && plugins.updatable.length > 0
    return hostUpdate || pluginUpdate
  } catch {
    return false
  }
}
