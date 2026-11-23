import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('包声明了服务端与客户端入口', () => {
  expect(pkg.name).toBe('dsh-upgrade')
  expect(pkg.main).toBe('lib/index.js')
  expect(pkg.exports['.']).toBe('./lib/index.js')
  expect(pkg.exports['./client']).toBe('./lib/client.js')
  expect(pkg.dsh.client.platform).toBe('web')
  expect(pkg.dsh.client.immediately).toBe(true)
})

test('运行期没有第三方依赖', () => {
  expect(pkg.dependencies ?? {}).toEqual({})
})
