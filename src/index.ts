/**
 * dsh-upgrade 插件入口。
 *
 * 三步互不依赖：挂 HTTP 路由、注册两个 agent 工具、补一次「升级完成」通知。
 * 任何一步失败都只记一条日志，绝不让宿主启动失败——插件装坏了不该拖垮 dsh web。
 */
import { readHostInfo } from './server/host'
import { settlePending } from './server/notify'
import { registerUpgradeRoutes, type UpgradeRouteContext } from './server/routes'
import { registerTools, type ToolContextLike } from './server/tools'

export const name = 'dsh-upgrade'

/**
 * 路由要拿 ctx.webServer；不声明 inject 的话 cordis 会在服务还没就绪时就 load 插件。
 * 只要 webServer 这一个服务，别的服务不 inject、也不读。
 */
export const inject = ['webServer']

type PluginContext = UpgradeRouteContext & ToolContextLike

export function apply(ctx: PluginContext): void {
  try {
    registerUpgradeRoutes(ctx)
  } catch (error) {
    console.warn(`[dsh-upgrade] 路由没挂上：${messageOf(error)}`)
  }

  try {
    registerTools(ctx)
  } catch (error) {
    console.warn(`[dsh-upgrade] agent 工具没注册上：${messageOf(error)}`)
  }

  // R19：补通知是锦上添花，异步补一次即可；settlePending 自己永不抛，这里再兜一层。
  try {
    void readHostInfo()
      .then((host) => settlePending(host.version))
      .catch((error: unknown) => {
        console.warn(`[dsh-upgrade] 补升级通知失败：${messageOf(error)}`)
      })
  } catch (error) {
    console.warn(`[dsh-upgrade] 补升级通知失败：${messageOf(error)}`)
  }
}

export default { name, inject, apply }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
