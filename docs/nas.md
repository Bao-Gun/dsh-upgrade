# NAS 真机验收

Linux（飞牛 NAS）上「通过索引安装 → 拒绝路径 → 沙箱真升 / 真回滚 → 重启链」的实测记录。实施计划见 `docs/superpowers/plans/2026-11-24-linux-support.md`（Task 7），这里只记跑出来的事实。

## 环境快照（待填）

| 项目 | 实测值 | 备注 |
|---|---|---|
| `node -v` | 待填 | |
| `npm -v` | 待填 | |
| `npm prefix -g` | 待填 | 预期 `/home/admin/.local`，与 dsh 实际安装位置不同 |
| dsh 安装目录 | 待填 | 预期 `/usr/local/lib/node_modules/@deepseek-ai/dsh`（root 所有） |
| dsh 当前版本 | 待填 | |
| 索引里的 spec | 待填 | `github:Bao-Gun/dsh-upgrade#<commit>` |
| 插件安装耗时 | 待填 | |
| dsh web 重启耗时 | 待填 | |

## 验收清单

- [ ] 通过索引安装：profile `package.json` 里落成 `github:…#<commit>`，`node_modules/dsh-upgrade` 就位。
- [ ] 重启后 `/dsh-upgrade/api/status` 返回 200，页面加载到 dsh-upgrade 的 client 资源。
- [ ] 拒绝路径：本体升级返回 `INSTALL_DIR_NOT_WRITABLE`，消息两行且含 `sudo npm i -g --prefix /usr/local`，没有产生新备份、版本没变。
- [ ] 沙箱真升一次：`ok:true`、沙箱里版本变了、`--version` 探针通过、备份已删。
- [ ] 沙箱回滚一次：`VERSION_MISMATCH` + `rolledBack:true`、沙箱目录回到旧版本、没有残留备份。
- [ ] 重启链：dsh-restart 预检读到 `done` → restart → `/health` 200 且 dsh-upgrade 仍在。
- [ ] 桌面通知：确认 `notify-send` 在这台 NAS 的会话里到底能不能出声。

## 实测记录（待填）

| 场景 | 期望 | 实测 | 证据 / 日志 |
|---|---|---|---|
| 索引安装 | 装到索引指定的 commit | 待填 | 待填 |
| 本体升级拒绝 | `INSTALL_DIR_NOT_WRITABLE`，两行可复制 | 待填 | 待填 |
| 沙箱真升 | `ok:true`，备份清理干净 | 待填 | 待填 |
| 沙箱回滚 | `VERSION_MISMATCH`，树回到旧版本 | 待填 | 待填 |
| 重启链 | 重启后服务与插件都在 | 待填 | 待填 |
| 备份实际用的 cp 候选 | 日志里是 `--reflink=auto -R` 或 `-R` | 待填 | 待填 |
| 磁盘占用 | 备份 / 副本大小 | 待填 | 待填 |
