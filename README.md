# dsh-upgrade

自用的 DSH 插件：给 dsh web 加升级能力，替代每次「手动升级全局 dsh 包 + 手动重启 dsh web」这套手工动作。只给一个人用。

## 跑起来

```bash
npm install
npm run build && node scripts/install.mjs --apply
```

装完重启 dsh web。只跑 `node scripts/install.mjs` 是 dry-run，只打印将要改什么。

## 平台支持

| 平台 | 支持情况 |
|---|---|
| macOS arm64 | 全功能：本体 / 插件升级、桌面通知、重启链；备份优先走 APFS clonefile。 |
| Linux（飞牛 NAS、systemd 用户级服务） | 插件升级、桌面通知（取决于会话有没有 DBus/通知后端，没有则静默跳过，见 `docs/gotchas.md`）、重启链可用；本体升级若 dsh 装在 root 所有的目录（如 `/usr/local`），会在备份前报 `INSTALL_DIR_NOT_WRITABLE` 并给出两行提示：哪一处不可写 + 一行可复制的 `sudo` 命令，需要手动执行。 |
| 其它平台 | 未验证：备份只走普通 `cp -R`，桌面通知静默跳过。 |

## 用法

底栏的升级图标打开面板。本体段升级 dsh 本身；插件段只有一条路：

- 「全部升级」：按顺序把每个可更新插件升一遍，每个插件行第二行显示自己的进度与失败原因；中途一个包失败不会吞掉后面的包。
- 升完出现「重启 DSH」：点第一下只进入「确认重启？」（重启会掐断当前会话），第二下才真的预检 → 重启；没装 dsh-restart 时不给按钮，只提示手动重启。

批量结束后列表不会自动刷新，先关面板重开再看还剩什么可升（见 `docs/gotchas.md`）。

## 检查

```bash
bash check.sh
```

## 目录

| 路径 | 放什么 |
|---|---|
| `src/` | 代码 |
| `docs/architecture.md` | 系统怎么跑 |
| `docs/gotchas.md` | 踩过的坑 |
| `.work/` | 草稿，不进 git |

每类内容该写在哪、什么时候读哪个文件：见 `AGENTS.md`。
