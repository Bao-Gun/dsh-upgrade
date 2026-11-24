#!/bin/sh
# 一条命令判断对不对。绿 = 全部通过，红 = 有东西坏了。
# ①②③ 是骨架自带的；④ 是项目的构建 / 类型 / 测试验收（含产物与用例数下限）。
cd "$(dirname "$0")" || exit 1
fail=0
bad() { printf '✗ %s\n' "$1" >&2; fail=1; }

# ① AGENTS.md 是热缓存，超过 80 行就开始侵蚀注意力
if [ -f AGENTS.md ]; then
  n=$(wc -l < AGENTS.md | tr -d ' ')
  [ "$n" -gt 80 ] && bad "AGENTS.md 有 ${n} 行，超过 80 行上限，细节挪进 docs/ 并留指针"
fi

# ② 文档里点过名的路径必须真实存在
# 待补全标记里的例子不算「文档点了名」，跳过那些行
# docs/superpowers/ 是冻结的历史快照（计划/设计稿），只查活文档，免得旧计划里的路径把验收钉死
live_docs=$(find docs -type f -name '*.md' -not -path 'docs/superpowers/*' 2>/dev/null)
for p in $(grep -rhE '(src|tests|docs|specs)/[A-Za-z0-9_./-]+' AGENTS.md $live_docs specs 2>/dev/null | grep -v '待补全' | grep -v '例：' | grep -oE '(src|tests|docs|specs)/[A-Za-z0-9_./-]+' | sort -u); do
  case "$p" in
    */) continue ;;                                   # 目录引用，不查
    *xxx*|*XXX*|*YYYY*|*NNN*|*slug*|*...*) continue ;;  # 模板里的示例路径，不查
  esac
  [ -e "$p" ] || bad "文档引用了不存在的路径: ${p}"
done

# ③ change 做完了却没归档
for t in specs/changes/*/tasks.md; do
  [ -f "$t" ] || continue
  case "$t" in */archive/*) continue ;; esac
  if grep -q '^- \[x\]' "$t" && ! grep -q '^- \[ \]' "$t"; then
    bad "${t} 全部勾完却没挪进 specs/changes/archive/"
  fi
done

# ③.5 发布契约：装得上才算插件。dsh.bundle.patch 缺了就是 not-a-bundle，路径拼错也是
patch=$(node -e 'const p=require("./package.json");process.stdout.write((p.dsh&&p.dsh.bundle&&p.dsh.bundle.patch)||"")' 2>/dev/null)
if [ -z "$patch" ]; then
  bad "package.json 没有 dsh.bundle.patch，装上去会报 not-a-bundle"
else
  [ -f "$patch" ] || bad "dsh.bundle.patch 指向的文件不存在: [object Object]"
fi

# ④ 构建 / 类型检查 / 测试，一条挂了不挡其它条
npm run build || bad "构建失败"
# lib/index.js 与 lib/client.js 是 package.json exports 和安装脚本 REQUIRED_ARTIFACTS 的承诺：tsup 静默少产物要红
for a in lib/index.js lib/client.js; do
  [ -f "$a" ] || bad "构建产物缺失: ${a}"
done
npx tsc --noEmit || bad "类型检查失败"
# 先收下输出：既原样打印，也数一遍用例数（防整批用例被删还报绿；下限 252 = 208 + 批量升级、重启链与入口显隐至少 44 条）
test_out=$(npm test 2>&1); test_rc=$?
printf '%s\n' "$test_out"
[ "$test_rc" -eq 0 ] || bad "测试失败"
passed=$(printf '%s\n' "$test_out" | grep -oE 'Tests +[0-9]+ passed' | grep -oE '[0-9]+' | head -1)
if [ -n "$passed" ] && [ "$passed" -lt 252 ]; then
  bad "只跑了 ${passed} 个用例，少于 252（批量升级、重启链与入口显隐至少应有 252 条）"
fi

if [ "$fail" -eq 0 ]; then echo '✓ 全部通过'; else echo '✗ 有未通过项' >&2; fi
exit "$fail"
