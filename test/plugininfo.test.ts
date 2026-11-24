import { describe, expect, test, vi } from 'vitest'
import { RAW_BASES, pluginVersions, repoOfSpec } from '../src/server/plugininfo'

const PROFILE = '/profile'

/** 每个用例用自己的 commit，免得模块级缓存在用例之间串味。 */
function commitOf(digit: string): string {
  return digit.repeat(40)
}

function profileFiles(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path: string) => {
    const value = files[path]
    if (value === undefined) throw new Error('ENOENT ' + path)
    return value
  }
}

function pkg(version: string): string {
  return JSON.stringify({ version })
}

function depsFor(files: Record<string, string>, fetchJson: (url: string) => Promise<unknown>) {
  return {
    profileDir: PROFILE,
    readText: profileFiles(files),
    fetchJson,
    now: () => 0,
  }
}

const GITHUB_SPEC = 'github:Bao-Gun/dsh-upgrade#' + 'a'.repeat(40)
const RAW = RAW_BASES[0] ?? ''
const MIRROR = RAW_BASES[1] ?? ''

describe('repoOfSpec', () => {
  test('认 github: 简写，含或不含 ref 都行', () => {
    expect(repoOfSpec(GITHUB_SPEC)).toBe('Bao-Gun/dsh-upgrade')
    expect(repoOfSpec('github:Bao-Gun/dsh-upgrade')).toBe('Bao-Gun/dsh-upgrade')
  })

  test('认 git+https / git+ssh / https 三种完整 URL', () => {
    expect(repoOfSpec('git+https://github.com/Bao-Gun/dsh-upgrade.git#abc')).toBe('Bao-Gun/dsh-upgrade')
    expect(repoOfSpec('git+ssh://git@github.com/Bao-Gun/dsh-upgrade.git#abc')).toBe('Bao-Gun/dsh-upgrade')
    expect(repoOfSpec('https://github.com/Bao-Gun/dsh-upgrade#abc')).toBe('Bao-Gun/dsh-upgrade')
  })

  test('软链 / npm / 空串一律认不出（不猜）', () => {
    expect(repoOfSpec('link:/Users/x/plugin/dsh-upgrade')).toBeNull()
    expect(repoOfSpec('npm:@scope/name@1.2.3')).toBeNull()
    expect(repoOfSpec('   ')).toBeNull()
  })
})

describe('pluginVersions', () => {
  test('已装版本读本地 package.json，目标版本取该 commit 的 package.json', async () => {
    const commit = commitOf('1')
    const fetchJson = vi.fn(async (_url: string) => ({ version: '0.2.2' }))
    const result = await pluginVersions('dsh-upgrade', commit, depsFor({
      [PROFILE + '/package.json']: JSON.stringify({ dependencies: { 'dsh-upgrade': 'github:Bao-Gun/dsh-upgrade#' + commit } }),
      [PROFILE + '/node_modules/dsh-upgrade/package.json']: pkg('0.2.1'),
    }, fetchJson))

    expect(result).toEqual({ installed: '0.2.1', latest: '0.2.2' })
    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(fetchJson).toHaveBeenCalledWith(RAW + '/Bao-Gun/dsh-upgrade/' + commit + '/package.json')
  })

  test('第一站不通就换 ghproxy 镜像', async () => {
    const commit = commitOf('2')
    const fetchJson = vi.fn(async (url: string) => {
      if (url.startsWith(RAW)) throw new Error('ECONNRESET')
      return { version: '0.2.2' }
    })
    const result = await pluginVersions('dsh-upgrade', commit, depsFor({
      [PROFILE + '/package.json']: JSON.stringify({ dependencies: { 'dsh-upgrade': 'github:Bao-Gun/dsh-upgrade#' + commit } }),
      [PROFILE + '/node_modules/dsh-upgrade/package.json']: pkg('0.2.1'),
    }, fetchJson))

    expect(result).toEqual({ installed: '0.2.1', latest: '0.2.2' })
    expect(fetchJson).toHaveBeenCalledTimes(2)
    expect(fetchJson).toHaveBeenLastCalledWith(MIRROR + '/Bao-Gun/dsh-upgrade/' + commit + '/package.json')
  })

  test('两站都不通：latest 为 null，installed 仍给出来', async () => {
    const commit = commitOf('3')
    const fetchJson = vi.fn(async () => { throw new Error('offline') })
    const result = await pluginVersions('dsh-upgrade', commit, depsFor({
      [PROFILE + '/package.json']: JSON.stringify({ dependencies: { 'dsh-upgrade': 'github:Bao-Gun/dsh-upgrade#' + commit } }),
      [PROFILE + '/node_modules/dsh-upgrade/package.json']: pkg('0.2.1'),
    }, fetchJson))

    expect(result).toEqual({ installed: '0.2.1', latest: null })
  })

  test('软链安装（link:）不发网络请求，latest 为 null', async () => {
    const fetchJson = vi.fn(async (_url: string) => ({ version: '0.2.2' }))
    const result = await pluginVersions('dsh-upgrade', commitOf('4'), depsFor({
      [PROFILE + '/package.json']: JSON.stringify({ dependencies: { 'dsh-upgrade': 'link:/Users/x/plugin/dsh-upgrade' } }),
      [PROFILE + '/node_modules/dsh-upgrade/package.json']: pkg('0.2.1'),
    }, fetchJson))

    expect(result).toEqual({ installed: '0.2.1', latest: null })
    expect(fetchJson).not.toHaveBeenCalled()
  })

  test('同一个 commit 第二次直接命中缓存', async () => {
    const commit = commitOf('5')
    const fetchJson = vi.fn(async (_url: string) => ({ version: '0.2.2' }))
    const files = {
      [PROFILE + '/package.json']: JSON.stringify({ dependencies: { 'dsh-upgrade': 'github:Bao-Gun/dsh-upgrade#' + commit } }),
      [PROFILE + '/node_modules/dsh-upgrade/package.json']: pkg('0.2.1'),
    }
    await pluginVersions('dsh-upgrade', commit, depsFor(files, fetchJson))
    const again = await pluginVersions('dsh-upgrade', commit, depsFor(files, fetchJson))

    expect(again.latest).toBe('0.2.2')
    expect(fetchJson).toHaveBeenCalledTimes(1)
  })

  test('包名越界或 commit 形状不对：一个文件都不读', async () => {
    const readText = vi.fn(async (_path: string) => '{}')
    const fetchJson = vi.fn(async (_url: string) => ({ version: '0.2.2' }))
    const deps = { profileDir: PROFILE, readText, fetchJson, now: () => 0 }

    expect(await pluginVersions('../../etc/passwd', commitOf('6'), deps)).toEqual({ installed: null, latest: null })
    expect(await pluginVersions('dsh-upgrade', 'not-a-commit', deps)).toEqual({ installed: null, latest: null })
    expect(readText).not.toHaveBeenCalled()
    expect(fetchJson).not.toHaveBeenCalled()
  })

  test('已装包的 package.json 读不到：installed 为 null，latest 照常', async () => {
    const commit = commitOf('7')
    const fetchJson = vi.fn(async (_url: string) => ({ version: '0.2.2' }))
    const result = await pluginVersions('dsh-upgrade', commit, depsFor({
      [PROFILE + '/package.json']: JSON.stringify({ dependencies: { 'dsh-upgrade': 'github:Bao-Gun/dsh-upgrade#' + commit } }),
    }, fetchJson))

    expect(result).toEqual({ installed: null, latest: '0.2.2' })
  })
})
