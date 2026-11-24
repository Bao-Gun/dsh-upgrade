import { delimiter as pathDelimiter, isAbsolute, join, sep } from 'node:path'

/** npm 全局包固定落在 <prefix>/lib/node_modules 下，这是唯一认得的安装形状。 */
const INSTALL_SUFFIX = join('lib', 'node_modules', '@deepseek-ai', 'dsh')

/**
 * 从安装目录反推 npm 全局前缀：/usr/local/lib/node_modules/@deepseek-ai/dsh → /usr/local。
 * NAS 上 npm prefix -g 是 /home/admin/.local 而 dsh 在 /usr/local：让 npm 自己决定前缀会装到
 * 别处、版本校验再逮住回滚，所以只认形状，推不出来就交给调用方失败。
 */
export function npmPrefixOf(installDir: string): string | null {
  // 只有绝对路径才谈得上「回到某个 <prefix>」：../lib/... 会切出 '..'，拿它当 --prefix 等于赌 cwd
  if (!isAbsolute(installDir)) return null
  const suffix = sep + INSTALL_SUFFIX
  if (!installDir.endsWith(suffix)) return null
  const prefix = installDir.slice(0, -suffix.length)
  // 前缀为空说明整条路径就是后缀本身（装在根 / 下），没有可回的 <prefix>
  return prefix === '' ? null : prefix
}

/**
 * dsh web 在 NAS 上由 systemd 用户级服务拉起，PATH 里未必有 node/npm。
 * node 同目录有 npm 就用绝对路径，找不到才退回 PATH，保持开发机行为不变。
 */
export function npmBin(nodeDir: string, exists: (p: string) => boolean): string {
  const candidate = join(nodeDir, 'npm')
  return exists(candidate) ? candidate : 'npm'
}

/**
 * PATH 头部补 node 目录，按分隔符切段比较——字符串包含判断会把 /opt/node/bin2
 * 误当成已有 /opt/node/bin。
 */
export function npmEnv(
  env: NodeJS.ProcessEnv,
  nodeDir: string,
  delimiter: string = pathDelimiter,
): NodeJS.ProcessEnv {
  const current = env.PATH ?? ''
  if (current === '') return { ...env, PATH: nodeDir }
  if (current.split(delimiter).includes(nodeDir)) return { ...env }
  return { ...env, PATH: nodeDir + delimiter + current }
}
