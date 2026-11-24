import { describe, expect, test } from 'vitest'
import { npmBin, npmEnv, npmPrefixOf } from '../src/server/npm'

describe('npmPrefixOf', () => {
  test('homebrew 前缀', () => {
    expect(npmPrefixOf('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh')).toBe('/opt/homebrew')
  })

  test('/usr/local 前缀（NAS 上 root 装的 dsh）', () => {
    expect(npmPrefixOf('/usr/local/lib/node_modules/@deepseek-ai/dsh')).toBe('/usr/local')
  })

  test('版本化目录也按形状切，不猜「上数三层」', () => {
    expect(
      npmPrefixOf('/opt/homebrew/Cellar/dsh/0.2.2-rc.5/lib/node_modules/@deepseek-ai/dsh'),
    ).toBe('/opt/homebrew/Cellar/dsh/0.2.2-rc.5')
  })

  test('相对路径推不出前缀', () => {
    expect(npmPrefixOf('lib/node_modules/@deepseek-ai/dsh')).toBeNull()
    expect(npmPrefixOf('node_modules/@deepseek-ai/dsh')).toBeNull()
  })

  test('少了 /lib/node_modules 或包名对不上都推不出', () => {
    expect(npmPrefixOf('/usr/local/lib/@deepseek-ai/dsh')).toBeNull()
    expect(npmPrefixOf('/usr/local/lib/node_modules/@deepseek-ai')).toBeNull()
    expect(npmPrefixOf('/usr/local/lib/node_modules/@deepseek-ai/dsh-extra')).toBeNull()
  })

  test('整条路径就是后缀本身时前缀为空，推不出', () => {
    expect(npmPrefixOf('/lib/node_modules/@deepseek-ai/dsh')).toBeNull()
  })
})

describe('npmBin', () => {
  test('node 同目录有 npm 就用绝对路径', () => {
    expect(npmBin('/opt/homebrew/bin', (p) => p === '/opt/homebrew/bin/npm')).toBe('/opt/homebrew/bin/npm')
  })

  test('同目录没有 npm 就退回 PATH 里的 npm', () => {
    expect(npmBin('/opt/homebrew/bin', () => false)).toBe('npm')
  })

  test('只问同目录的 npm 一次', () => {
    const asked: string[] = []
    npmBin('/usr/bin', (p) => {
      asked.push(p)
      return false
    })
    expect(asked).toEqual(['/usr/bin/npm'])
  })
})

describe('npmEnv', () => {
  test('PATH 头部补 node 目录', () => {
    expect(npmEnv({ PATH: '/usr/bin:/bin' }, '/opt/node/bin').PATH).toBe('/opt/node/bin:/usr/bin:/bin')
  })

  test('PATH 里已有这一段就不重复加', () => {
    expect(npmEnv({ PATH: '/usr/bin:/opt/node/bin' }, '/opt/node/bin').PATH).toBe('/usr/bin:/opt/node/bin')
  })

  test('只按分隔符切段比较：/opt/node/bin2 不算已有 /opt/node/bin', () => {
    expect(npmEnv({ PATH: '/opt/node/bin2' }, '/opt/node/bin').PATH).toBe('/opt/node/bin:/opt/node/bin2')
  })

  test('空 PATH 直接当成唯一一段，不留前导分隔符', () => {
    expect(npmEnv({ PATH: '' }, '/opt/node/bin').PATH).toBe('/opt/node/bin')
  })

  test('没有 PATH 时补上，其它变量原样保留', () => {
    expect(npmEnv({ HOME: '/home/admin' }, '/opt/node/bin')).toEqual({
      HOME: '/home/admin',
      PATH: '/opt/node/bin',
    })
  })

  test('分隔符可注入（Windows 用 ;）', () => {
    expect(npmEnv({ PATH: 'C:\\Windows' }, 'C:\\node', ';').PATH).toBe('C:\\node;C:\\Windows')
  })

  test('不改传入的 env', () => {
    const env = { PATH: '/usr/bin' }
    npmEnv(env, '/opt/node/bin')
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})
