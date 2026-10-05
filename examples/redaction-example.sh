#!/usr/bin/env bash
# 出处遮盖（按出处原文撤回公开展示）端到端调用示例。
#
# 流程：经「整理包导入」建立出处带首尾空白的草稿（模拟真实写入路径：
#       整包导入 / 并行会话保存都会原样保留出处首尾空白；关系出处手工录入也原样保留）
#       → 发布两个版本 → 编辑者粘贴无空白原文只读预览命中（首尾空白折叠）
#       → 携最新版本号确认遮盖
#       → 核对访客视图（「出处已遮盖」）与编辑口令原文视图
#       → 空文本 400、预览后新版本 409、重复确认幂等、内部空白仍须逐字一致。
#
# 匹配规则（本轮）：登记文本与库存出处各自 trim（去除两端全部空白字符：空格 / 制表 /
#           换行 / 全角空格等）后严格相等即命中；仅首尾空白不同的写法视为同一出处；
#           内部空白与其他文字逐字区分（内部多空格、部分包含、前后多字都不命中）。
#
# 依赖：curl 与 node（本应用本身就需要 node，用于解析 / 构造 JSON）。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/redaction-example.sh
# 可重复运行（出处文本带时间戳，避免与历史数据互相干扰）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"

# node 小工具：从标准输入的 JSON 中取字段
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
# 把参数编码为 JSON 字符串字面量
jstr() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

# 库存出处故意带首尾空白（模拟整包导入 / 并行会话保存的写法）
SRC_STORED="  示例受访人口述 ${TS}（2026-09-01 访谈，录音 01 段）  "
# 编辑者预览 / 确认时粘贴的原文（无首尾空白；trim 后与库存出处相等）
SRC="$(node -e 'process.stdout.write(process.argv[1].trim())' "$SRC_STORED")"
SRC_STORED_TAB="	${SRC}	"  # 另一空白变体（首尾为制表符）
SRC2="另一位受访人口述 ${TS}"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
latest_no() { curl -s "$BASE/api/public/versions" | jfield 'd.currentVersionNo'; }

# 导入一个整理包（参数：bundle JSON 字符串）；回传 JSON 结果到标准输出
import_bundle() {
  local bundle="$1"
  local pv
  pv=$(post "$BASE/api/editor/import-preview" -d "$bundle")
  local body
  body=$(printf '%s' "$bundle" | node -e '
    const b = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const pv = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify({ bundle: b, fingerprint: pv.fingerprint, draftRevisionNo: pv.draftRevisionNo }));
  ' "$pv")
  post "$BASE/api/editor/import" -d "$body"
}

say "0) 口令检查（错误口令应 401）"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" \
  -H 'X-Editor-Token: wrong-token' -d '{"source":"x"}' "$BASE/api/editor/redaction-preview")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 经整理包导入建草稿：2 个事件 + 主张（出处首尾带空白）+ 一条先于关系（出处同为空白变体）"
BUNDLE=$(TS="$TS" SRC_STORED="$SRC_STORED" node -e '
  const ts = process.env.TS, src = process.env.SRC_STORED;
  process.stdout.write(JSON.stringify({
    batchId: `redaction-ws-example-${ts}`,
    events: [
      { key: "e1", title: `示例动员会 ${ts}`, claims: [
        { precision: "day", year: 1958, month: 9, day: 12, source: src } ] },
      { key: "e2", title: `示例通水会 ${ts}`, claims: [
        { precision: "month", year: 1959, month: 5, source: `志书第 87 页 ${ts}` } ] },
    ],
    relations: [ { earlierKey: "e1", laterKey: "e2", source: ` ${src.trim()} ` } ],
  }));')
IMP=$(import_bundle "$BUNDLE")
E1=$(echo "$IMP" | jfield 'd.idMap.events.find(x=>x.key==="e1").eventId')
E2=$(echo "$IMP" | jfield 'd.idMap.events.find(x=>x.key==="e2").eventId')
C1=$(echo "$IMP" | jfield 'd.idMap.events.find(x=>x.key==="e1").claimIds[0]')
C2=$(echo "$IMP" | jfield 'd.idMap.events.find(x=>x.key==="e2").claimIds[0]')
echo "事件 $E1、$E2；主张 $C1、$C2（库存出处首尾空白原样保留）"

say "2) 发布下一版"
post "$BASE/api/editor/publish" \
  -d '{"selection":[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'}],"baseVersionNo":'"$(latest_no)"',"note":"遮盖示例首版","editor":"示例脚本"}' \
  | jfield '"versionNo=" + d.versionNo + "\n"'

say "3) 草稿再经导入加一个出处首尾空白不同（制表符）的事件，发布下一版（验证跨版本、跨空白变体命中）"
BUNDLE2=$(TS="$TS" SRC_TAB="$SRC_STORED_TAB" node -e '
  const ts = process.env.TS;
  process.stdout.write(JSON.stringify({
    batchId: `redaction-ws-example-${ts}-b`,
    events: [
      { key: "e3", title: `示例抽水机到站 ${ts}`, claims: [
        { precision: "year", year: 1962, source: process.env.SRC_TAB } ] },
    ],
    relations: [],
  }));')
IMP2=$(import_bundle "$BUNDLE2")
E3=$(echo "$IMP2" | jfield 'd.idMap.events[0].eventId')
C3=$(echo "$IMP2" | jfield 'd.idMap.events[0].claimIds[0]')
post "$BASE/api/editor/publish" \
  -d '{"selection":[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'},{"eventId":'"$E3"',"claimId":'"$C3"'}],"baseVersionNo":'"$(latest_no)"',"note":"遮盖示例二版","editor":"示例脚本"}' \
  | jfield '"versionNo=" + d.versionNo + "\n"'

say "4) 只读预览：粘贴无空白原文，命中库存带首尾空白的写法（返回命中位置、数量与库存原文）"
PREVIEW=$(post "$BASE/api/editor/redaction-preview" -d "{\"source\":$(jstr "$SRC")}")
echo "$PREVIEW" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("source（trim 后规范文本）=", JSON.stringify(d.source));
console.log("latestVersion =", d.currentVersionNo, " 已发布版本数 =", d.versionCount);
console.log("事件主张命中  =", d.totalEventHitCount, " 先于关系命中 =", d.totalRelationHitCount, " 合计 =", d.totalHitCount);
for (const v of d.versions) console.log(`  第 ${v.versionNo} 版：事件 ${v.eventHitCount} 处、关系 ${v.relationHitCount} 处`,
  v.eventHits.map(h=>`事件「${h.title}」库存原文=${JSON.stringify(h.source)}`).join(" "),
  v.relationHits.map(h=>`关系 ${h.earlierEventId}→${h.laterEventId} 库存原文=${JSON.stringify(h.source)}`).join(" "));'
[ "$(echo "$PREVIEW" | jfield 'd.totalHitCount')" = "5" ] && echo "OK：合计命中 5 处（v1:2 + v2:3）" || { echo "FAIL：期望命中 5 处"; exit 1; }
LATEST=$(echo "$PREVIEW" | jfield 'd.currentVersionNo')

say "4b) 内部空白仍逐字区分：内部多一个空格的文本不命中（首尾空白折叠不等于忽略全部空白）"
INNER="$(SRC="$SRC" node -e 'process.stdout.write(process.env.SRC.replace(" ", "  "))')"
N=$(post "$BASE/api/editor/redaction-preview" -d "{\"source\":$(jstr "$INNER")}" | jfield 'd.totalHitCount')
echo "内部双空格变体命中数 = $N（应为 0）"
[ "$N" = "0" ] || { echo "FAIL：内部空白不同不应命中"; exit 1; }

say "5) 空 / 纯空白文本 → 400"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" \
  "$BASE/api/editor/redaction-preview" -d '{"source":"   "}')
[ "$code" = 400 ] && echo "OK：空文本返回 400" || { echo "FAIL：期望 400，实际 $code"; exit 1; }

say "6) 携预览时的最新版本号确认遮盖（提交无空白规范文本；登记按 trim 后文本去重）"
post "$BASE/api/editor/redaction" \
  -d "{\"source\":$(jstr "$SRC"),\"currentVersionNo\":$LATEST,\"editor\":\"示例脚本\"}" \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("alreadyRedacted =", d.alreadyRedacted, " 遮盖标签 =", d.redactedLabel, " 当前命中 =", d.totalHitCount);'

say "7) 访客读取最新年表：库存首尾空白变体命中处显示「出处已遮盖」，其余字段不变"
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("currentVersionNo =", d.currentVersionNo);
for (const e of d.version.events) console.log(`  事件「${e.title}」 出处=[${e.source}] 日期=${e.resolvedDate}`);
for (const r of d.version.relations) console.log(`  关系 ${r.earlierEventId}→${r.laterEventId} 出处=[${r.source}]`);'

say "8) 访客读取指定历史版本：同样遮盖"
curl -s "$BASE/api/public/versions/1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("第 1 版事件出处 =", d.version.events.map(e=>e.source));
console.log("第 1 版关系出处 =", d.version.relations.map(r=>r.source));'

say "9) 持编辑口令查看版本原文：仍是带首尾空白的库存原文；草稿不受影响"
get_ed "$BASE/api/editor/versions/1/raw" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("原文视图事件出处 =", d.version.events.map(e=>JSON.stringify(e.source)));
console.log("原文视图关系出处 =", d.version.relations.map(r=>JSON.stringify(r.source)));'
get_ed "$BASE/api/editor/state" | TS="$TS" node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("草稿区出处仍为原文 =", JSON.stringify(d.events.flatMap(e=>e.claims.map(c=>c.source)).filter(s=>s.includes(process.env.TS))));'

say "10) 重复确认 → 200 alreadyRedacted:true（带不带首尾空白都归一为同一登记，不重复落库）"
post "$BASE/api/editor/redaction" -d "{\"source\":$(jstr " $SRC "),\"currentVersionNo\":999}" \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.alreadyRedacted !== true) process.exit(1);
console.log("OK：alreadyRedacted =", d.alreadyRedacted, " 当前命中 =", d.totalHitCount);'

say "11) 预览后若有新版本 → 确认 409 VERSION_CONFLICT，不落库"
post "$BASE/api/editor/redaction-preview" -d "{\"source\":$(jstr "$SRC2")}" >/dev/null  # 先预览另一文本
CUR="$(latest_no)"
BEFORE=$(get_ed "$BASE/api/editor/redactions" | jfield 'd.redactions.length')
# 期间发布一个新版本（内容不变，仅为推进版本号）
post "$BASE/api/editor/publish" \
  -d '{"selection":[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'},{"eventId":'"$E3"',"claimId":'"$C3"'}],"baseVersionNo":'"$CUR"',"note":"推进版本号触发冲突","editor":"示例脚本"}' >/dev/null
RESP=$(post -w $'\n%{http_code}' "$BASE/api/editor/redaction" \
  -d "{\"source\":$(jstr "$SRC2"),\"currentVersionNo\":$CUR}")
code=$(printf '%s' "$RESP" | tail -1)
printf '%s' "$RESP" | sed '$d' | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("code =", d.code, " currentVersionNo =", d.currentVersionNo, " expectedVersionNo =", d.expectedVersionNo);'
echo "HTTP $code"
[ "$code" = 409 ] || { echo "FAIL：期望 409，实际 $code"; exit 1; }
AFTER=$(get_ed "$BASE/api/editor/redactions" | jfield 'd.redactions.length')
[ "$BEFORE" = "$AFTER" ] && echo "OK：冲突未登记新遮盖（清单数量 $AFTER 不变）" || { echo "FAIL：409 却落库了"; exit 1; }

say "12) 已登记遮盖清单（编辑者视角，含 trim 后的规范原文）"
get_ed "$BASE/api/editor/redactions" | TS="$TS" node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
for (const r of d.redactions.filter(x=>x.source.includes(process.env.TS)))
  console.log(`  [${r.id}] ${r.source}  登记于 ${r.redactedAt} UTC  by ${r.editor||"匿名"}`);'

say "全部断言通过 ✅"
echo "提示：可打开 $BASE/ 查看访客年表（出处显示「出处已遮盖」），$BASE/editor 查看版本原文。"
