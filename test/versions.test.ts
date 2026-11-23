import { describe, expect, test } from 'vitest'
import { channelOf, compareVersions, isNewer, pickNewest, satisfiesNodeRange, describeEnginesFailure } from '../src/server/versions'

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
})

describe('describeEnginesFailure', () => {
  test('说清需要什么、本机是什么', () => {
    expect(describeEnginesFailure('^24.22.3 || >=26.13.1', '26.7.0')).toBe('需要 Node ^24.22.3 || >=26.13.1，本机 26.7.0')
  })
})
