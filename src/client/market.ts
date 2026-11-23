/**
 * dshmarket v1 的浏览器侧适配层。
 *
 * 只在页面里用同源 fetch 调 dshmarket：这些端点都有 DSH 登录保护，服务端
 * 调不到，只有页面里的 fetch 会带上宿主的会话 cookie。
 *
 * 这个文件是纯映射，不做安装、不轮询、不碰 DOM。任何失败都收敛为
 * “不可用”，绝不把异常抛进渲染路径。
 */

export const SUMMARY = '/dsh-market/api/v1/updates/summary'
export const UPDATES = '/dsh-market/api/v1/updates'
export const OPERATIONS = '/dsh-market/api/v1/operations'

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
}

export type StartedPluginUpdate = {
  operationId: string
}

export type PluginOperation = {
  status: PluginOperationStatus
  restartRequired: boolean
  message?: string
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

function unavailableUpdates(): PluginUpdates {
  return { available: false, updatable: [] }
}

function unavailableOperation(): PluginOperation {
  return { status: 'failed', restartRequired: false, message: '插件更新不可用' }
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

/**
 * 读取可更新的插件列表。
 *
 * available 表示“这个端点这次能用”，与“有没有更新”无关：200 + 空 packages
 * 是 available: true / updatable: []；401、500、坏 JSON、空响应、fetch 抛错
 * 一律 available: false / updatable: []。
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

    const body: unknown = await response.json()
    if (!isRecord(body) || !Array.isArray(body.packages)) return unavailableUpdates()

    const updatable: PluginUpdate[] = []
    for (const entry of body.packages) {
      const update = toPluginUpdate(entry)
      if (update !== null) updatable.push(update)
    }
    return { available: true, updatable }
  } catch {
    return unavailableUpdates()
  }
}

/**
 * 发起一次插件升级。成功时返回 operationId，失败返回空字符串。
 *
 * v1 的实际响应是 { operation, ... }，operationId 在 operation 里；顶层的
 * operationId 只作为旧 beta 形状的兜底。
 */
export async function startPluginUpdate(
  name: string,
  fetchImpl: FetchImpl = fetch,
): Promise<StartedPluginUpdate> {
  try {
    const response = await fetchImpl(UPDATES, {
      method: 'POST',
      credentials: 'same-origin',
      headers: requestHeaders(true),
      body: JSON.stringify({ packageName: name }),
    })
    if (response.ok !== true) return { operationId: '' }

    const body: unknown = await response.json()
    if (!isRecord(body)) return { operationId: '' }

    const operation = isRecord(body.operation) ? body.operation : null
    if (operation !== null && typeof operation.operationId === 'string') {
      return { operationId: operation.operationId }
    }
    if (typeof body.operationId === 'string') return { operationId: body.operationId }
    return { operationId: '' }
  } catch {
    return { operationId: '' }
  }
}

/**
 * 查询一次操作状态。调用方负责轮询节奏，这里只做一次请求与映射。
 *
 * v1 的状态与 restartRequired 分别在 operation.state 与 operation.outcome
 * 里，用户的失败原因在 operation.failure.message；任何取不到的情况都返回
 * failed + 不可用文案，不抛。
 */
export async function pollPluginOperation(
  operationId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<PluginOperation> {
  if (operationId === '') return unavailableOperation()

  try {
    const url = `${OPERATIONS}?operationId=${encodeURIComponent(operationId)}`
    const response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: requestHeaders(false),
    })
    if (response.ok !== true) return unavailableOperation()

    const body: unknown = await response.json()
    if (!isRecord(body) || !isRecord(body.operation)) return unavailableOperation()

    const operation = body.operation
    if (!isOperationStatus(operation.state)) return unavailableOperation()

    const outcome = isRecord(operation.outcome) ? operation.outcome : {}
    const result: PluginOperation = {
      status: operation.state,
      restartRequired: outcome.restartRequired === true,
    }
    const failure = isRecord(operation.failure) ? operation.failure : null
    if (failure !== null && typeof failure.message === 'string' && failure.message !== '') {
      result.message = failure.message
    }
    return result
  } catch {
    return unavailableOperation()
  }
}
