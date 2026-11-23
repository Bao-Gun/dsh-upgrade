/**
 * dshmarket v1 的浏览器侧适配层。
 *
 * 只在页面里用同源 fetch 调 dshmarket：这些端点都有 DSH 登录保护，服务端
 * 调不到，只有页面里的 fetch 会带上宿主的会话 cookie。
 *
 * 这个文件是纯映射，不做安装、不轮询、不碰 DOM。任何失败都收敛成结果对象，
 * 绝不把异常抛进渲染路径。失败结果带 code 区分“安装真失败”和“请求层不可用”，
 * 免得一次网络抖动被误报成升级失败。
 */

export const SUMMARY = '/dsh-market/api/v1/updates/summary'
export const UPDATES = '/dsh-market/api/v1/updates'
export const OPERATIONS = '/dsh-market/api/v1/operations'

const MARKET_UNAVAILABLE = 'MARKET_UNAVAILABLE'
const OPERATION_UNKNOWN = 'OPERATION_UNKNOWN'
const MARKET_UNAUTHORIZED = 'MARKET_UNAUTHORIZED'
const UPDATE_FAILED = 'UPDATE_FAILED'
const UNAVAILABLE_MESSAGE = '插件更新不可用'
const UNAUTHORIZED_MESSAGE = '需要先登录 DSH'
const UNKNOWN_OPERATION_MESSAGE = '升级记录已失效，宿主可能已重启'

/**
 * R27：面板必须按 code 分流，不能看 status === 'failed'。
 * 一次请求层抖动（MARKET_UNAVAILABLE）和一次真安装失败（宿主给的
 * INSTALL_FAILED 之类）都是 status:'failed'，只有 code 能分开。
 */
export type PluginOperationCode =
  | 'MARKET_UNAVAILABLE'
  | 'OPERATION_UNKNOWN'
  | 'MARKET_UNAUTHORIZED'
  | 'UPDATE_FAILED'

export const PLUGIN_MARKET_UNAVAILABLE: PluginOperationCode = 'MARKET_UNAVAILABLE'
export const PLUGIN_OPERATION_UNKNOWN: PluginOperationCode = 'OPERATION_UNKNOWN'
export const PLUGIN_MARKET_UNAUTHORIZED: PluginOperationCode = 'MARKET_UNAUTHORIZED'
export const PLUGIN_UPDATE_FAILED: PluginOperationCode = 'UPDATE_FAILED'

/** 这三种都不是「装挂了」，面板统一说「插件更新不可用」。 */
const UNAVAILABLE_CODES: readonly string[] = [
  PLUGIN_MARKET_UNAVAILABLE,
  PLUGIN_OPERATION_UNKNOWN,
  PLUGIN_MARKET_UNAUTHORIZED,
]

export function isPluginUnavailableCode(code: string | undefined): boolean {
  return typeof code === 'string' && UNAVAILABLE_CODES.includes(code)
}

export type PluginUpdate = {
  name: string
  from: string
  to: string
  publishedAt?: string
  repo?: string
}

export type PluginOperationStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rolled-back'

export type PluginUpdates = {
  available: boolean
  updatable: PluginUpdate[]
  /** 宿主这次实际检查过的包数；缺失或不是非负整数时不出现。 */
  checked?: number
}

export type StartedPluginUpdate = {
  /** 成功时非空；失败时为空字符串，原因看 code/message。 */
  operationId: string
  code?: string
  message?: string
}

/**
 * dshmarket 在 running 状态会给的结构化进度（pnpm 给的）：
 * percent 只在 total 有值时才是个数，否则为 null——那时按不确定进度画。
 */
export type PluginProgress = {
  percent: number | null
  phase: string | null
  detail: string | null
  done: number | null
  total: number | null
}

/** 排队中宿主给出的解释（为什么还没开跑）。 */
export type PluginWait = {
  code: string | null
  message: string | null
  activeAgentIds: string[]
}

export type PluginOperation = {
  status: PluginOperationStatus
  restartRequired: boolean
  /** running 时有；其它状态可能缺。 */
  progress?: PluginProgress
  /** queued 且有解释时有。 */
  wait?: PluginWait
  /**
   * failed 的分类：宿主 failure.code 表示安装真失败；请求层另有
   * MARKET_UNAVAILABLE / OPERATION_UNKNOWN / MARKET_UNAUTHORIZED。
   */
  code?: string
  message?: string
  retryable?: boolean
}

type FetchImpl = typeof fetch

const OPERATION_STATES: readonly PluginOperationStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'rolled-back',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOperationStatus(value: unknown): value is PluginOperationStatus {
  return typeof value === 'string' && (OPERATION_STATES as readonly string[]).includes(value)
}

/** base 是 origin 或部署前缀；常量路径自带 /dsh-market，不能再补一次。 */
function withBase(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 进度是可选的：字段缺失或类型不对就整块当作没有，而不是画一条 0% 的假进度。
 * percent 在 total 为 null 时是 null——那代表 pnpm 还在跑但没有总量。
 */
function normalizeProgress(value: unknown): PluginProgress | undefined {
  if (!isRecord(value)) return undefined
  const wait: PluginProgress = {
    percent: numberOrNull(value.percent),
    phase: typeof value.phase === 'string' && value.phase !== '' ? value.phase : null,
    detail: typeof value.detail === 'string' && value.detail !== '' ? value.detail : null,
    done: numberOrNull(value.done),
    total: numberOrNull(value.total),
  }
  if (wait.percent === null && wait.phase === null && wait.detail === null) return undefined
  if (wait.percent !== null) {
    const clamped = Math.min(100, Math.max(0, Math.round(wait.percent)))
    wait.percent = clamped
  }
  return wait
}

function normalizeWait(value: unknown): PluginWait | undefined {
  if (!isRecord(value)) return undefined
  const ids: string[] = []
  if (Array.isArray(value.activeAgentIds)) {
    for (const item of value.activeAgentIds) {
      if (typeof item === 'string' && item !== '') ids.push(item)
    }
  }
  const wait: PluginWait = {
    code: typeof value.code === 'string' && value.code !== '' ? value.code : null,
    message: typeof value.message === 'string' && value.message !== '' ? value.message : null,
    activeAgentIds: ids,
  }
  if (wait.code === null && wait.message === null && ids.length === 0) return undefined
  return wait
}

function unavailableUpdates(): PluginUpdates {
  return { available: false, updatable: [] }
}

function unavailableOperation(): PluginOperation {
  return {
    status: 'failed',
    restartRequired: false,
    code: MARKET_UNAVAILABLE,
    message: UNAVAILABLE_MESSAGE,
    retryable: true,
  }
}

function unknownOperation(): PluginOperation {
  return {
    status: 'failed',
    restartRequired: false,
    code: OPERATION_UNKNOWN,
    message: UNKNOWN_OPERATION_MESSAGE,
    retryable: false,
  }
}

function unauthorizedOperation(): PluginOperation {
  return {
    status: 'failed',
    restartRequired: false,
    code: MARKET_UNAUTHORIZED,
    message: UNAUTHORIZED_MESSAGE,
    retryable: false,
  }
}

function pollFailure(status: number): PluginOperation {
  if (status === 404) return unknownOperation()
  if (status === 401) return unauthorizedOperation()
  return unavailableOperation()
}

type FailureDetails = { code: string; message: string }

/** 启动失败时尽量保留宿主给的 code/message，同时兜住纯文本错误。 */
function failureDetails(body: unknown, status: number): FailureDetails {
  const fallback: FailureDetails =
    status === 401
      ? { code: MARKET_UNAUTHORIZED, message: UNAUTHORIZED_MESSAGE }
      : { code: MARKET_UNAVAILABLE, message: UNAVAILABLE_MESSAGE }

  if (!isRecord(body)) return fallback

  const failure = isRecord(body.failure) ? body.failure : null
  const code =
    failure !== null && typeof failure.code === 'string' && failure.code !== ''
      ? failure.code
      : fallback.code
  const message =
    failure !== null && typeof failure.message === 'string' && failure.message !== ''
      ? failure.message
      : typeof body.error === 'string' && body.error !== ''
        ? body.error
        : fallback.message

  return { code, message }
}

function toPluginUpdate(value: unknown): PluginUpdate | null {
  if (!isRecord(value)) return null
  const name = value.name
  const from = value.installedVersion
  const to = value.latestVersion
  if (typeof name !== 'string' || name === '') return null
  if (typeof from !== 'string' || from === '') return null
  if (typeof to !== 'string' || to === '') return null

  const update: PluginUpdate = { name, from, to }
  // summary 目前只给 name/source/installedVersion/latestVersion；这两个字段
  // 是 beta 契约里可能追加的可选项，出现就带上，不出现不补空值。
  if (typeof value.publishedAt === 'string' && value.publishedAt !== '') {
    update.publishedAt = value.publishedAt
  }
  if (typeof value.repo === 'string' && value.repo !== '') {
    update.repo = value.repo
  }
  return update
}

function requestHeaders(jsonBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (jsonBody) headers['Content-Type'] = 'application/json'
  return headers
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * 读取可更新的插件列表。
 *
 * available 表示“这个端点这次能用”，与“有没有更新”无关：200 + 空 packages
 * 是 available: true / updatable: []；401、500、坏 JSON、空响应、fetch 抛错
 * 一律 available: false / updatable: []。checked 是宿主实际检查的包数，有就带。
 *
 * base 可传 origin（如 http://127.0.0.1:3080）或部署前缀；默认同源。
 */
export async function fetchPluginUpdates(
  fetchImpl: FetchImpl = fetch,
  base = '',
): Promise<PluginUpdates> {
  try {
    const response = await fetchImpl(withBase(base, SUMMARY), {
      method: 'GET',
      credentials: 'same-origin',
      headers: requestHeaders(false),
    })
    if (response.ok !== true) return unavailableUpdates()

    const body: unknown = await readJsonBody(response)
    if (!isRecord(body) || !Array.isArray(body.packages)) return unavailableUpdates()

    const updatable: PluginUpdate[] = []
    for (const entry of body.packages) {
      const update = toPluginUpdate(entry)
      if (update !== null) updatable.push(update)
    }
    const result: PluginUpdates = { available: true, updatable }
    if (typeof body.checked === 'number' && Number.isInteger(body.checked) && body.checked >= 0) {
      result.checked = body.checked
    }
    return result
  } catch {
    return unavailableUpdates()
  }
}

/**
 * 发起一次插件升级。成功时返回 operationId，失败返回空字符串，并用 code/message
 * 说明原因（如 OPERATION_BUSY、AGENT_DRAIN_UNSUPPORTED、MARKET_UNAUTHORIZED）。
 *
 * v1 的实际响应是 { operation, ... }，operationId 在 operation 里；顶层的
 * operationId 只作为旧 beta 形状的兜底。
 */
export async function startPluginUpdate(
  name: string,
  fetchImpl: FetchImpl = fetch,
  base = '',
): Promise<StartedPluginUpdate> {
  try {
    const response = await fetchImpl(withBase(base, UPDATES), {
      method: 'POST',
      credentials: 'same-origin',
      headers: requestHeaders(true),
      body: JSON.stringify({ packageName: name }),
    })
    const body: unknown = await readJsonBody(response)
    if (response.ok !== true) {
      const failure = failureDetails(body, response.status)
      return { operationId: '', code: failure.code, message: failure.message }
    }
    if (!isRecord(body)) {
      return { operationId: '', code: MARKET_UNAVAILABLE, message: UNAVAILABLE_MESSAGE }
    }

    const operation = isRecord(body.operation) ? body.operation : null
    if (operation !== null && typeof operation.operationId === 'string' && operation.operationId !== '') {
      return { operationId: operation.operationId }
    }
    if (typeof body.operationId === 'string' && body.operationId !== '') {
      return { operationId: body.operationId }
    }
    return { operationId: '', code: MARKET_UNAVAILABLE, message: UNAVAILABLE_MESSAGE }
  } catch {
    return { operationId: '', code: MARKET_UNAVAILABLE, message: UNAVAILABLE_MESSAGE }
  }
}

/**
 * 查询一次操作状态。调用方负责轮询节奏，这里只做一次请求与映射。
 *
 * v1 的状态与 restartRequired 分别在 operation.state 与 operation.outcome
 * 里，安装失败原因在 operation.failure。请求层失败不伪装成安装失败：
 * 404 是记录已随宿主重启消失（OPERATION_UNKNOWN），401 是登录失效
 * （MARKET_UNAUTHORIZED），其余网络/解析/5xx 是 MARKET_UNAVAILABLE。不抛。
 */
export async function pollPluginOperation(
  operationId: string,
  fetchImpl: FetchImpl = fetch,
  base = '',
): Promise<PluginOperation> {
  if (operationId === '') return unknownOperation()

  try {
    const url = withBase(base, OPERATIONS) + `?operationId=${encodeURIComponent(operationId)}`
    const response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: requestHeaders(false),
    })
    if (response.ok !== true) return pollFailure(response.status)

    const body: unknown = await readJsonBody(response)
    if (!isRecord(body) || !isRecord(body.operation)) return unavailableOperation()

    const operation = body.operation
    if (!isOperationStatus(operation.state)) return unavailableOperation()

    const outcome = isRecord(operation.outcome) ? operation.outcome : {}
    const result: PluginOperation = {
      status: operation.state,
      restartRequired: outcome.restartRequired === true,
    }
    const progress = normalizeProgress(operation.progress)
    if (progress !== undefined) result.progress = progress
    const wait = normalizeWait(operation.wait)
    if (wait !== undefined) result.wait = wait
    const failure = isRecord(operation.failure) ? operation.failure : null
    if (failure !== null) {
      if (typeof failure.code === 'string' && failure.code !== '') result.code = failure.code
      if (typeof failure.message === 'string' && failure.message !== '') {
        result.message = failure.message
      }
      if (typeof failure.retryable === 'boolean') result.retryable = failure.retryable
    }
    if (result.status === 'failed') {
      if (result.code === undefined) result.code = UPDATE_FAILED
      if (result.retryable === undefined) result.retryable = false
    }
    return result
  } catch {
    return unavailableOperation()
  }
}
