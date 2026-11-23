import { defineConfig } from 'tsup'

// 两份产物、两种运行环境：
// - 宿主入口 src/index.ts 跑在 Node 里，@deepseek-ai/* 是宿主提供的运行期依赖，
//   必须 external，绝不能内联进产物。
// - 客户端入口 src/client/index.ts 跑在浏览器里，用 classic script 加载，
//   必须产出 iife，并用 banner/footer 把整个模块体包进宿主的 factory，
//   保证首行自注册、模块体副作用延迟到 materialize 时执行。
// 注意：产物目录清理由 package.json 的 build 脚本负责（rm -rf lib）；
// tsup 对数组配置是并发执行的，任何一项 clean: true 都会在另一项写完后删掉产物。
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'lib',
    splitting: false,
    sourcemap: true,
    external: [/^@deepseek-ai\//],
  },
  {
    entry: { client: 'src/client/index.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib',
    splitting: false,
    sourcemap: true,
    outExtension: () => ({ js: '.js' }),
    globalName: '__dsh_upgrade_client',
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "dsh-upgrade", factory: (require) => {',
    },
    footer: {
      js: 'return __dsh_upgrade_client;\n} });',
    },
  },
])
