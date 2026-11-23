# dsh-upgrade

自用的 DSH 插件：给 dsh web 加一个升级能力，替代「手动升级全局 dsh 包 + 手动重启服务」这套动作。只服务一个人。

## 目录地图

| 路径 | 放什么 | 不放什么 |
|---|---|---|
| `src/` | 代码 | 文档、样本数据 |
| `docs/` | 说明文字 | 代码 |
| `docs/architecture.md` | 系统怎么跑：模块表、数据流、关键约束 | 需求、待办 |
| `docs/gotchas.md` | 踩过的坑，只追加不整理 | 通用编程常识 |
| `docs/README.md` | `docs/` 里的命名与分文件规则 | 项目说明 |
| `.work/` | 草稿、临时计划（不进 git） | 任何还要留下的东西 |
| `check.sh` | 唯一的验收脚本 | —— |

## 什么时候读什么

| 你要做 | 先读 |
|---|---|
| 第一次进这个项目 | 本文件 → `README.md` → `docs/architecture.md` |
| 改某块逻辑 | `docs/architecture.md` 的模块表，按路径直接跳源码，别全库乱读 |
| 行为看着不对、像有坑 | `docs/gotchas.md` |
| 想知道怎么验收 | 本文件「命令」一节 → `check.sh` |

## 命令

- 启动：⚠️ 待补全：启动命令 —— 要补成一行能启动的命令（例：`npm run dev`）；补在：本行
- 检查：`bash check.sh`（唯一判断对错的方式，别靠肉眼）

## 现在缺什么

| 缺什么 | 要补成 | 补在哪 |
|---|---|---|
| 启动命令 | 一行能启动的命令 | 上面「启动」那行 |
| 测试 / 验收命令 | 一行能跑的命令（例：`npm test`、`pytest -q`） | `check.sh` 第 ④ 段 |
| 模块表 | 每个模块一行：路径 / 职责 / 谁调用它（例：`src/upgrade.js` / 执行升级并重启 / `src/index.js`） | `docs/architecture.md`「模块」表 |
| 数据流 | 一行：从哪进来 → 经过哪 → 存到哪 | `docs/architecture.md`「数据流」 |
| 第一条坑 | 现象 → 原因 → 做法 | `docs/gotchas.md` |

## 维护

- 本文件 ≤ 80 行，只当路由器。细节写进 `docs/`，这里留指针。
- 改了某个模块，同批改 `docs/architecture.md` 对应那段。
- `check.sh` 只准加严：删断言、加 `|| true`、改 `exit 0` 都算作弊。
