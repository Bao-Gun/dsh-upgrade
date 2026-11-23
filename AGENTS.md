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
| `docs/superpowers/plans/` | superpowers 写的实施计划，一个功能一份（进 git） | 改过的旧计划（原件不再动） |
| `docs/superpowers/specs/` | superpowers 写的设计稿（进 git） | 已落地的结论（搬进 `docs/architecture.md`） |
| `scripts/` | 安装 / 运维脚本（纯 Node，不进打包） | 运行期代码 |
| `cordis.patch.yml` | 装进 profile 的 cordis patch 片段，安装脚本原样追加 | 项目自己的配置 |
| `.superpowers/` | superpowers 的执行工作台：进度、任务简报、评审包（自动忽略，别提交） | 任何要长期留的东西 |
| `.work/` | 草稿、临时计划（不进 git） | 任何还要留下的东西 |
| `check.sh` | 唯一的验收脚本 | —— |

## 什么时候读什么

| 你要做 | 先读 |
|---|---|
| 第一次进这个项目 | 本文件 → `README.md` → `docs/architecture.md` |
| 改某块逻辑 | `docs/architecture.md` 的模块表，按路径直接跳源码，别全库乱读 |
| 行为看着不对、像有坑 | `docs/gotchas.md` |
| 接着做某个进行中的功能 | `docs/superpowers/plans/` 里对应那份（进度以它为准，别重写） |
| 想不起当初为什么这么设计 | `docs/superpowers/specs/` 里的设计稿 |
| 想知道怎么验收 | 本文件「命令」一节 → `check.sh` |

## 命令

- 启动：`npm run build && node scripts/install.mjs --apply`（装进 web profile 后重启 dsh web；只跑 `node scripts/install.mjs` 是 dry-run）
- 检查：`bash check.sh`（唯一判断对错的方式，别靠肉眼）。收尾要贴出退出码和结果行再说完成。
- 并行开发：工作树放 `.worktrees/`（已在忽略列表）。有 harness 原生 worktree 工具就用它，别手搓 `git worktree`。

## 维护

- 本文件 ≤ 80 行，只当路由器。细节写进 `docs/`，这里留指针。
- 改了某个模块，同批改 `docs/architecture.md` 对应那段。
- `docs/superpowers/` 里的计划与设计稿是**当时的样子**，功能收尾后不再改；还成立的结论搬进 `docs/architecture.md`。
- `.superpowers/` 只由 superpowers 自己读写：不提交、不整理、不在里面手写东西。
- `check.sh` 只准加严：删断言、加 `|| true`、改 `exit 0` 都算作弊。
