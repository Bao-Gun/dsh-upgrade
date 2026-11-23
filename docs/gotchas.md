# 坑

只追加，不整理。一条一行：什么情况下会踩 → 为什么 → 怎么绕。
整理过的坑会失真，宁可粗糙也别汇总成「注意事项」。

- 升级到 `@deepseek-ai/dsh@0.2.3-alpha.2` 后 `dsh web` 起不来（npm 装得上，进程启动即退） → 该版本 `engines.node` 是 `^24.22.3 || >=26.13.1`，本机 node v26.7.0 落在空档里，npm 只告警不拦；0.2.2-rc.5 的 `>=24.9.0` 则满足 → 升级前必须用目标版本 manifest 的 `engines.node` 先校验（`src/server/upgrade.ts` 在备份之前调 `satisfiesNodeRange`，失败文案由 `src/server/versions.ts` 的 `describeEnginesFailure` 生成），不满足就停在 precheck，别装。
- 升级或回滚进行到一半进程被杀，`dsh web` 再也起不来（安装目录整个消失，重装前连 npm 都找不到已装包） → `src/server/upgrade.ts` 的回滚是 `rm -rf installDir` 之后才 `rename(backup → installDir)`，两步之间不是原子的；这时磁盘上是「`~/.dsh/dsh-upgrade/backup/<from>` 有完整备份、`pending.json` 还在、`last.json` 没写」 → 别重装、别删备份：`mv ~/.dsh/dsh-upgrade/backup/<from> /opt/homebrew/lib/node_modules/@deepseek-ai/dsh`（或 `npm i -g @deepseek-ai/dsh@<from>`）先把树恢复，再启动确认，最后清掉 `pending.json`。
