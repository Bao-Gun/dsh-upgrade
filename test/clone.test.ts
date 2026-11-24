import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { cloneCandidates } from '../src/server/clone'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const installUrl = pathToFileURL(join(repoRoot, 'scripts', 'install.mjs')).href

/** scripts/install.mjs 是纯 JS、不参与 tsc；用变量 URL 动态 import，避免 TS7016。 */
async function loadInstall(): Promise<any> {
  return import(installUrl)
}

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux', 'freebsd', 'win32']

describe('克隆候选表', () => {
  it('darwin 先 APFS clonefile，再退回普通拷贝', () => {
    expect(cloneCandidates('darwin', 'a', 'b')).toEqual([
      ['-c', '-R', 'a', 'b'],
      ['-R', 'a', 'b'],
    ])
  })

  it('linux 先 reflink=auto（btrfs/xfs 真 CoW，ext4 退化为整拷），再退回普通拷贝', () => {
    expect(cloneCandidates('linux', 'a', 'b')).toEqual([
      ['--reflink=auto', '-R', 'a', 'b'],
      ['-R', 'a', 'b'],
    ])
  })

  it('其它平台只给普通拷贝', () => {
    expect(cloneCandidates('freebsd', 'a', 'b')).toEqual([['-R', 'a', 'b']])
    expect(cloneCandidates('win32', 'a', 'b')).toEqual([['-R', 'a', 'b']])
  })

  it('候选表给的是完整 argv：递归拷贝 + 源在前、目标在后', () => {
    for (const platform of PLATFORMS) {
      for (const args of cloneCandidates(platform, 'src-dir', 'dst-dir')) {
        expect(args).toContain('-R')
        expect(args).toContain('src-dir')
        expect(args).toContain('dst-dir')
        expect(args.slice(-2)).toEqual(['src-dir', 'dst-dir'])
      }
    }
  })

  it('绝不用硬链接（-l / --link 会共享 inode，试跑会写穿线上安装目录）', () => {
    for (const platform of PLATFORMS) {
      const candidates = cloneCandidates(platform, 'a', 'b')
      expect(candidates.length).toBeGreaterThan(0)
      for (const args of candidates) {
        expect(args).not.toContain('-l')
        expect(args).not.toContain('--link')
      }
      // 最后一条必须是真拷贝兜底，前面失败才有退路
      expect(candidates[candidates.length - 1]).toEqual(['-R', 'a', 'b'])
    }
  })
})

describe('install.mjs 与 clone.ts 不漂移', () => {
  it('cloneArgs 是候选表首选的完整 argv', async () => {
    const install = await loadInstall()
    for (const platform of PLATFORMS) {
      expect(install.cloneArgs('a', 'b', platform)).toEqual(cloneCandidates(platform, 'a', 'b')[0])
    }
  })

  it('install.mjs 的候选表与 clone.ts 逐项一致（改表必须同批改两边）', async () => {
    const install = await loadInstall()
    for (const platform of PLATFORMS) {
      expect(install.cloneCandidateList('a', 'b', platform)).toEqual(cloneCandidates(platform, 'a', 'b'))
    }
  })
})
