# NAS 真机验收

Linux（飞牛 NAS）上「通过索引安装 → 拒绝路径 → 沙箱真升 / 真回滚 → 重启链」的实测记录。实施计划见 `docs/superpowers/plans/2026-11-24-linux-support.md`（Task 7），这里只记跑出来的事实。

实测日期 2026-11-24，插件版本 0.2.0（commit `5d53ab6`），dsh `0.2.2-rc.5`；当晚 22:03 又用同一条路径升到 0.2.1（`ab4f8cd`），记在文末。

## 环境快照

| 项目 | 实测值 | 备注 |
|---|---|---|
| `node -v` | `v24.22.1` | `/usr/local/bin/node` |
| `npm -v` | `11.19.1` | registry 默认 `https://registry.npmjs.org/`，`ignore-scripts=false` |
| `npm prefix -g` | `/home/admin/.local` | 与 dsh 真正装的地方不同，所以前缀必须从 installDir 反推 |
| dsh 安装目录 | `/usr/local/lib/node_modules/@deepseek-ai/dsh` | root:root，admin 不可写 |
| dsh 当前版本 | `0.2.2-rc.5` | 系统 `ext4`（`/dev/nvme0n1p2`） |
| 索引里的 spec | `github:Bao-Gun/dsh-upgrade#5d53ab6404be8ac7c2beb681441915568f975d32` | 索引 `site/index.json` 的 `versions[0].source.commit` |
| 插件安装耗时 | 7.2s | pnpm 10.34.9，走 ghproxy 镜像 |
| dsh web 重启耗时 | 1s | `systemctl --user restart dsh-watchdog` 与 dsh-restart 的 `/api/restart` 都是 1s 内 `/health` 200 |

## 验收清单

- [x] 通过索引安装：profile `package.json` 里落成 `github:…#5d53ab6`，`node_modules/dsh-upgrade` 就位（`package.json` 0.2.0，`lib/` 下两份构建产物齐全）。
- [x] 重启后 `/dsh-upgrade/api/status` 返回 200（`current: 0.2.2-rc.5`），页面 `__DSH_BOOT__.entries` 里有 `dsh-upgrade`（`immediately: true`）。
- [x] 拒绝路径：本体升级返回 `INSTALL_DIR_NOT_WRITABLE`，消息两行且含 `sudo npm i -g --prefix /usr/local`，没有产生新备份、版本没变。
- [x] 沙箱真升一次：`ok:true`、沙箱里版本从 `0.2.2-rc.4` 变 `0.2.2-rc.5`、`--version` 探针通过、备份已删。
- [x] 沙箱回滚一次：`VERSION_MISMATCH` + `rolledBack:true`、沙箱目录回到 `0.2.2-rc.5`、没有残留版本备份目录。
- [x] 重启链：预检 `done` 且 `ok:true` → restart → `/health` 200 且 dsh-upgrade 的 status 仍 200。
- [x] 桌面通知：这台没装 `notify-send`，通知静默跳过（见下）。

## 实测记录

| 场景 | 期望 | 实测 | 证据 / 日志 |
|---|---|---|---|
| 索引安装 | 装到索引指定的 commit | 7.2s 装完，`Packages: +1 -9` 后 11 个原有依赖完好 | `/tmp/dshup-install.log` |
| 本体升级拒绝 | `INSTALL_DIR_NOT_WRITABLE`，两行可复制 | 命中。第二行是 `手动执行：sudo npm i -g --prefix /usr/local @deepseek-ai/dsh@0.2.2-rc.4` | `~/.dsh/dsh-upgrade/` 只有 `cache.json`/`last.json`/`pending.json`，无 `backup/` |
| 沙箱真升 | `ok:true`，备份清理干净 | `0.2.2-rc.4 → 0.2.2-rc.5`，`backupsLeft: []` | `/tmp/dshup-selftest.log` |
| 沙箱回滚 | `VERSION_MISMATCH`，树回到旧版本 | `code: VERSION_MISMATCH`、`rolledBack: true`、`versionAfter: 0.2.2-rc.5` | 同上（场景 B 注入探针 `0.0.0-rollback-probe`） |
| 重启链 | 重启后服务与插件都在 | 预检第二次 `ok:true`，restart 返回 `{"ok":true,"port":3080}`，1s 后 `/health` 200，两个插件 status 都 200 | dsh-restart `logDir: /home/admin/.dsh/dsh-restart` |
| 备份实际用的 cp 候选 | 日志里是 `--reflink=auto -R` 或 `-R` | `--reflink=auto -R`，ext4 上由 coreutils 退化成整拷，不报错 | 手工计时：1.2G 目录 7.4s |
| 磁盘占用 | 备份 / 副本大小 | 单份 1.2G；升级同时最多 2.4G（磁盘余 91G，阈值 2.5GB 够用） | `du -sh` |

## 这台机器上的三个外部事实

1. **直连 GitHub 挂死，必须走镜像。** `git ls-remote https://github.com/…` 45s 无输出；`ssh -D` 的 SOCKS 隧道当时也不通。可用的是 ghproxy：raw 2.4s、`git ls-remote https://ghproxy.net/https://github.com/Bao-Gun/dsh-upgrade.git` 直通。pnpm 装 git 依赖时用一次性环境改写（不写进全局 git config）：

   ```sh
   GIT_CONFIG_COUNT=1 \
   GIT_CONFIG_KEY_0=url.https://ghproxy.net/https://github.com/.insteadOf \
   GIT_CONFIG_VALUE_0=https://github.com/ \
   dsh plugin --profile web add "github:Bao-Gun/dsh-upgrade#5d53ab64…"
   ```

2. **没有 `notify-send`。** `/run/user/1000/bus` 在，但 `command -v notify-send` 为空 ⇒ `notifyUpgraded` spawn 报 ENOENT、返回 false、静默跳过，升级本身不受影响。真要让 NAS 出声得先装 `libnotify-bin`。
3. **npm 11 默认跳过 install-scripts。** 沙箱里 `npm i -g` 会警告 `@deepseek-ai/dsh-subprocess-local, koffi, node-pty, @google/genai, protobufjs` 的 postinstall 没跑；`dsh --version` 照样正常，但带原生依赖的能力会缺。（本体升级在 NAS 上本来就被可写性检查挡住，这条暂时只影响手工装。）

## 两个值得记住的抖动（不是本插件的缺陷）

- **首次预检的 boot 阶段可能超时。** 第一次 `POST /dsh-restart/api/precheck` 用了 14.7s 且 `stage: boot, ok: false`，原因是试跑实例 12s 内没打印 Web URL（stdout 里混着 chrome-devtools-mcp 的提示噪声）；立刻重跑一次 10.4s 就 `ok: true, health: true`。所以重启链在这台机器上是「偶尔第一次拦下」，重试即可。
- **刚重启完的 1～2 秒内插件路由还没注册。** `/health` 已 200，但紧接着查 `/dsh-upgrade/api/status` 是空响应；等 8 秒再查就正常 200。

## 复现命令

```sh
# 沙箱里真升一次 + 探针失败回滚一次（只碰 --prefix 指定的目录）
cd /tmp && git clone --depth 1 https://ghproxy.net/https://github.com/Bao-Gun/dsh-upgrade.git dshup-src
npm i -g --prefix /home/admin/.dshup-sandbox @deepseek-ai/dsh@0.2.2-rc.4
cd /tmp/dshup-src && npx --yes tsx scripts/nas-selftest.ts \
  --prefix /home/admin/.dshup-sandbox --target 0.2.2-rc.5 --root /tmp/dshup-selftest-root
```

整轮（两次 1.2G 备份 + 两次 npm 安装）约 90s；退出码 0 才是两个场景都对。

## 0.2.1 升级记录（2026-11-24 22:03）

同一条索引路径再装一次（ghproxy 环境改写，commit 取索引里 `versions[0].source.commit`）：

```sh
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='url.https://ghproxy.net/https://github.com/.insteadOf' \
GIT_CONFIG_VALUE_0='https://github.com/' \
dsh plugin --profile web add 'github:Bao-Gun/dsh-upgrade#ab4f8cd461cdf735b758385407a11679a60c0e86'
```

- 27.4s 装完（`Packages: +1 -9`），profile 里落成 `github:Bao-Gun/dsh-upgrade#ab4f8cd…`，插件 `package.json` 报 `0.2.1`。
- `lib/client.js` / `lib/index.js` 的 sha256 与本机仓库逐字节一致（`d9eb365c…` / `b2fe37e4…`），装的是同一个构建。
- 装完不动服务：`/health` 200、`/dsh-upgrade/api/status` 200、`dsh-watchdog.service` active。这次只改了客户端 bundle，刷新页面即可，不需要重启 dsh web。
