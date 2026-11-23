import { describe, expect, test } from 'vitest'
import { channelOf, compareVersions, isNewer, parseVersion, pickNewest, satisfiesNodeRange, describeEnginesFailure } from '../src/server/versions'

describe('compareVersions', () => {
  test('按 semver 比较主次补丁', () => {
    expect(compareVersions('0.2.3', '0.2.2')).toBeGreaterThan(0)
    expect(compareVersions('0.2.2-rc.5', '0.2.2')).toBeLessThan(0)
  })
  test('预发布按标识符逐段比，数字段当数字', () => {
    expect(compareVersions('0.2.3-alpha.2', '0.2.3-alpha.1')).toBeGreaterThan(0)
    expect(compareVersions('0.2.3-alpha.10', '0.2.3-alpha.9')).toBeGreaterThan(0)
    expect(compareVersions('0.2.2-rc.5', '0.2.2-rc.4')).toBeGreaterThan(0)
  })
  test('相等', () => {
    expect(compareVersions('0.2.2-rc.5', '0.2.2-rc.5')).toBe(0)
  })
  test('预发布数字段小于字母段，前缀相同时短的更小', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
  })
  test('不可比的版本抛错', () => {
    expect(() => compareVersions('x', '1.0.0')).toThrow()
  })
})

describe('parseVersion', () => {
  test('合法版本解析，非法返回 null', () => {
    expect(parseVersion('0.2.3-alpha.2')).toEqual({
      major: 0,
      minor: 2,
      patch: 3,
      prerelease: ['alpha', '2'],
    })
    expect(parseVersion('v24.22.3')).toEqual({ major: 24, minor: 22, patch: 3, prerelease: [] })
    expect(parseVersion('bogus')).toBeNull()
  })
})

describe('channelOf', () => {
  test('三种通道', () => {
    expect(channelOf('0.2.2-rc.5')).toBe('rc')
    expect(channelOf('0.2.3-alpha.2')).toBe('alpha')
    expect(channelOf('0.2.2')).toBe('stable')
  })
})

describe('pickNewest', () => {
  const versions = ['0.2.1', '0.2.2-rc.5', '0.2.3-alpha.1', '0.2.3-alpha.2']
  test('不含预发布时只在稳定版里挑', () => {
    expect(pickNewest(versions, { includePrerelease: false })).toBe('0.2.1')
  })
  test('含预发布时挑全局最大', () => {
    expect(pickNewest(versions, { includePrerelease: true })).toBe('0.2.3-alpha.2')
  })
  test('空列表返回 null', () => {
    expect(pickNewest([], { includePrerelease: true })).toBeNull()
  })
  test('跳过无法解析的候选', () => {
    expect(pickNewest(['bogus', '0.2.1'], { includePrerelease: false })).toBe('0.2.1')
  })
})

describe('isNewer', () => {
  test('本机 0.2.2-rc.5 对 alpha.2 为真，对 rc.5 为假', () => {
    expect(isNewer('0.2.3-alpha.2', '0.2.2-rc.5')).toBe(true)
    expect(isNewer('0.2.2-rc.5', '0.2.2-rc.5')).toBe(false)
  })
})

describe('satisfiesNodeRange', () => {
  test('^ 与 >= 的或组合（alpha.2 的真实要求）', () => {
    const range = '^24.22.3 || >=26.13.1'
    expect(satisfiesNodeRange(range, '26.7.0')).toBe(false)   // 本机真实情况
    expect(satisfiesNodeRange(range, '26.13.1')).toBe(true)
    expect(satisfiesNodeRange(range, '24.22.3')).toBe(true)
    expect(satisfiesNodeRange(range, '24.23.0')).toBe(true)
    expect(satisfiesNodeRange(range, '27.0.0')).toBe(true)
    expect(satisfiesNodeRange(range, '24.22.2')).toBe(false)
  })
  test('>= 单条与空串', () => {
    expect(satisfiesNodeRange('>=22', '22.0.0')).toBe(true)
    expect(satisfiesNodeRange('>=22', '21.9.9')).toBe(false)
    expect(satisfiesNodeRange('', '20.0.0')).toBe(true)
  })
  test('~、精确值与段内 AND', () => {
    expect(satisfiesNodeRange('~22.1', '22.1.9')).toBe(true)
    expect(satisfiesNodeRange('~22.1', '22.2.0')).toBe(false)
    expect(satisfiesNodeRange('>22 <23', '22.5.0')).toBe(false)   // npm：>22 即 >=23.0.0，与 <23 无交集
    expect(satisfiesNodeRange('>22 <23', '23.0.0')).toBe(false)
    expect(satisfiesNodeRange('>=22 <23', '22.5.0')).toBe(true)    // 段内 AND：两个条件同时成立
    expect(satisfiesNodeRange('>=22 <23', '23.0.0')).toBe(false)
    expect(satisfiesNodeRange('=22.0.0', '22.0.0')).toBe(true)
    expect(satisfiesNodeRange('=22.0.0', '22.0.1')).toBe(false)
  })
  test('x/X/* 通配符', () => {
    expect(satisfiesNodeRange('18.x', '26.7.0')).toBe(false)
    expect(satisfiesNodeRange('18.x', '18.5.0')).toBe(true)
    expect(satisfiesNodeRange('20.X', '20.1.0')).toBe(true)
    expect(satisfiesNodeRange('1.2.x', '1.2.9')).toBe(true)
    expect(satisfiesNodeRange('1.2.x', '1.3.0')).toBe(false)
    expect(satisfiesNodeRange('*', '26.7.0')).toBe(true)
    expect(satisfiesNodeRange('>=18 20.x', '20.5.0')).toBe(true)
    expect(satisfiesNodeRange('>=18 20.x', '21.0.0')).toBe(false)
  })
  test('连字符范围', () => {
    expect(satisfiesNodeRange('20.0.0 - 21', '20.9.9')).toBe(true)
    expect(satisfiesNodeRange('20.0.0 - 21', '22.0.0')).toBe(false)
    expect(satisfiesNodeRange('18.0.0 - 20.5.0', '20.5.0')).toBe(true)
    expect(satisfiesNodeRange('18.0.0 - 20.5.0', '20.5.1')).toBe(false)
  })
  test('真正无法解析的文本按满足处理（既定契约）', () => {
    expect(satisfiesNodeRange('not a range', '26.7.0')).toBe(true)
    expect(satisfiesNodeRange('<nonsense>', '26.7.0')).toBe(true)
  })
})

describe('describeEnginesFailure', () => {
  test('说清需要什么、本机是什么', () => {
    expect(describeEnginesFailure('^24.22.3 || >=26.13.1', '26.7.0')).toBe('需要 Node ^24.22.3 || >=26.13.1，本机 26.7.0')
  })
})
