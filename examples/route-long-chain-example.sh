#!/usr/bin/env bash
# 长链路线（两万事件顺链的首尾为锚点）端到端调用示例。
#
# 背景：编辑者从一份已发布年表中挑首尾两个事件作锚点建立专题脉络路线时，
# 见证链求解必须及时完成。见证链求解为「正 / 反向 BFS 定层 + 逐层最小关系 ID
# 贪心 + 父指针回溯」的线性实现，不逐层复制整条路径；每段仍是关系数最少的
# 见证链，同长度按关系 ID 序列字典序择小——结果与短链完全同一套规则。
#
# 流程：分 10 批经「采访整理包导入」铺 20000 事件逐日相接长链（每批 2000）
#       → 跨批补衔接关系 → 加 1 个无关系的孤立事件 → 组装 selection 发布第 1 版
#       → 以首尾事件为锚点建立路线（计时；唯一段即贯穿全链的最少关系见证链）
#       → 加中途锚点再建一条（两段各自最短）
#       → 断点拒绝：孤立事件不可达 → 422 指出全部断点（段号与两端事件），不保存
#       → 改草稿（删首条关系、改首事件标题）发布第 2 版 → 旧路线逐字节不变
#       → 出处遮盖：链上事件 / 关系出处命中处访客见「出处已遮盖」，编辑者看原文
#       → 撤回所据版本：访客路线 404 / 清单隐藏，编辑者仍可见原文（versionRetracted）
#
# 依赖：curl 与 node。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/route-long-chain-example.sh
#   可用 N=20000 BATCH=2000 调整链长与批大小（单批请求体须小于 1MB）。
# 总耗时约 20 秒。可重复运行（标题与出处带时间戳）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
N="${N:-20000}"
BATCH="${BATCH:-2000}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
get_pub() { curl -s "$@"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
editor_latest_no() { get_ed "$BASE/api/editor/state" | jfield 'd.currentVersionNo'; }

say "0) 口令检查（错误口令应 401）"
code=$(http_code -X POST "${h_json[@]}" -H 'X-Editor-Token: wrong' \
  -d '{"title":"x","versionNo":1,"anchorEventIds":[1,2]}' "$BASE/api/editor/routes")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 分批导入 ${N} 个事件的逐日相接长链（每批 ${BATCH} 个，经 import-preview → import）"
IDS_FILE="$(mktemp)"
BUNDLE_FILE="$(mktemp)"
: > "$IDS_FILE"
batches=$(( (N + BATCH - 1) / BATCH ))
for (( b=0; b<batches; b++ )); do
  lo=$(( b * BATCH + 1 ))
  hi=$(( lo + BATCH - 1 )); [ "$hi" -gt "$N" ] && hi="$N"
  # 整理包较大（数百 KB），写入临时文件后以 -d @文件 提交（避免命令行参数长度上限）
  node -e '
    const [lo, hi, ts] = process.argv.slice(1).map(Number);
    const events = [];
    for (let i = lo; i <= hi; i++) {
      // 逐日相接：第 i 个事件的主张日 = 1950-01-01 + (i-1) 天（日精度，区间即当天）
      const d = new Date(Date.UTC(1950, 0, i));
      events.push({ key: "e" + i, title: `长链路线示例第${i}日 ${ts}`,
        claims: [{ precision: "day", year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
          source: `长链路线示例口述第${i}册 ${ts}` }] });
    }
    const relations = [];
    for (let i = lo; i < hi; i++) relations.push({ earlierKey: "e" + i, laterKey: "e" + (i + 1), source: "逐日衔接" });
    console.log(JSON.stringify({ batchId: `route-long-chain-${ts}-${lo}`, events, relations }));
  ' "$lo" "$hi" "$TS" > "$BUNDLE_FILE"
  preview="$(post "$BASE/api/editor/import-preview" -d @"$BUNDLE_FILE")"
  fp="$(printf '%s' "$preview" | jfield 'd.fingerprint')"
  rev="$(printf '%s' "$preview" | jfield 'd.draftRevisionNo')"
  confirm="$(node -e 'const fs=require("fs");
    const bundle=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    console.log(JSON.stringify({ bundle, fingerprint: process.argv[2], draftRevisionNo: Number(process.argv[3]) }));' \
    "$BUNDLE_FILE" "$fp" "$rev" | post "$BASE/api/editor/import" -d @-)"
  printf '%s' "$confirm" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
    if(!d.ok){console.error("导入失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
    for(const e of d.idMap.events) console.log(`${e.eventId}\t${e.claimIds[0]}`);' >> "$IDS_FILE"
  echo "  批次 $((b + 1))/${batches} 已导入（累计 $(wc -l < "$IDS_FILE") 个事件）"
done
rm -f "$BUNDLE_FILE"

say "2) 跨批次补衔接关系（共 $((batches - 1)) 条）"
for (( b=1; b<batches; b++ )); do
  prev_tail="$(sed -n "$(( b * BATCH ))p" "$IDS_FILE" | cut -f1)"
  curr_head="$(sed -n "$(( b * BATCH + 1 ))p" "$IDS_FILE" | cut -f1)"
  post "$BASE/api/editor/relations" \
    -d '{"earlierId":'"$prev_tail"',"laterId":'"$curr_head"',"source":"跨批衔接"}' >/dev/null
done
echo "长链关系总数 = $((N - 1))"

say "3) 记录首 / 中 / 尾锚点，另加 1 个无任何关系的孤立事件"
FIRST="$(head -1 "$IDS_FILE" | cut -f1)"
MID="$(sed -n "$(( N / 2 ))p" "$IDS_FILE" | cut -f1)"
LAST="$(tail -1 "$IDS_FILE" | cut -f1)"
ISO="$(post "$BASE/api/editor/events" -d '{"title":"长链路线孤立事件 '"$TS"'"}' | jfield 'd.event.id')"
ISOC="$(post "$BASE/api/editor/events/$ISO/claims" \
  -d '{"precision":"day","year":1958,"month":1,"day":1,"source":"孤立事件出处 '"$TS"'"}' | jfield 'd.claim.id')"
printf '%s\t%s\n' "$ISO" "$ISOC" >> "$IDS_FILE"
echo "锚点：首=$FIRST 中=$MID 尾=$LAST；孤立事件=$ISO（用于断点演示）"

say "4) 组装 selection 并发布第 1 版"
SEL="$(node -e 'const fs=require("fs");
  const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>l.split("\t"));
  console.log(JSON.stringify(rows.map(([eventId,claimId])=>({eventId:Number(eventId),claimId:Number(claimId)}))));' "$IDS_FILE")"
V0="$(editor_latest_no)"
printf '%s' "{\"selection\":$SEL,\"baseVersionNo\":$V0,\"editor\":\"长链路线示例\",\"note\":\"长链路线示例 $TS\"}" \
  | post "$BASE/api/editor/publish" -d @- | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error("发布失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
console.log(`OK：第 ${d.versionNo} 版，${d.version.events.length} 事件 / ${d.version.relations.length} 关系`);'
V1="$(editor_latest_no)"

say "5) 以首尾事件为锚点建立路线：POST /api/editor/routes（计时）"
RESP="$(mktemp)"
T_CREATE="$(curl -s -o "$RESP" -w '%{time_total}' -X POST "${h_json[@]}" "${h_ed[@]}" \
  -d '{"title":"长链脉络 '"$TS"'","versionNo":'"$V1"',"anchorEventIds":['"$FIRST"','"$LAST"'],
       "editor":"长链路线示例","note":"两万事件顺链首尾为锚"}' \
  "$BASE/api/editor/routes")"
node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const [first, last, n, t] = process.argv.slice(2);
if(!d.ok){console.error("建路线失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
const r=d.route, seg=r.segments[0];
console.log(`OK：路线 #${r.routeNo} 建立耗时 ${Number(t).toFixed(2)}s（含 ${n} 事件版本读取与详情组装）`);
console.log(`  段数=${r.segments.length}；见证链 ${seg.eventIds.length} 事件 / ${seg.relationIds.length} 关系（关系数最少）`);
if(seg.eventIds[0]!==Number(first)||seg.eventIds[seg.eventIds.length-1]!==Number(last)){console.error("FAIL：链端点不符");process.exit(1);}
if(seg.eventIds.length!==Number(n)||seg.relationIds.length!==Number(n)-1){console.error("FAIL：链长不符");process.exit(1);}
if(r.events.filter(e=>e.role==="anchor").length!==2){console.error("FAIL：锚点标注不符");process.exit(1);}
console.log(`  锚点 ${first} → ${last}；关系 ID 序列 ${seg.relationIds[0]} … ${seg.relationIds[seg.relationIds.length-1]}`);' \
  "$RESP" "$FIRST" "$LAST" "$N" "$T_CREATE"
rm -f "$RESP"

say "6) 加中途锚点再建一条（首 → 中 → 尾，两段各自取最少关系链）"
post "$BASE/api/editor/routes" \
  -d '{"title":"长链脉络（含中途锚点） '"$TS"'","versionNo":'"$V1"',"anchorEventIds":['"$FIRST"','"$MID"','"$LAST"']}' \
  | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error("建路线失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
const s=d.route.segments;
console.log(`OK：路线 #${d.route.routeNo}，段数=${s.length}；第 1 段 ${s[0].eventIds.length} 事件，第 2 段 ${s[1].eventIds.length} 事件`);'

say "7) 断点拒绝：孤立事件不可达 → 422 指出全部断点，整条不保存"
CNT_BEFORE="$(get_ed "$BASE/api/editor/routes" | jfield 'd.routes.length')"
post "$BASE/api/editor/routes" \
  -d '{"title":"断点路线 '"$TS"'","versionNo":'"$V1"',"anchorEventIds":['"$FIRST"','"$ISO"','"$LAST"']}' \
  | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(d.status!==422||d.code!=="ROUTE_INVALID"){console.error("FAIL：期望 422 ROUTE_INVALID，实际 "+JSON.stringify(d).slice(0,200));process.exit(1);}
const discs=(d.errors||[]).filter(e=>e.type==="disconnected");
console.log(`OK：422 ROUTE_INVALID，${discs.length} 个断点：`);
for(const e of discs) console.log(`  段 ${e.segmentIndex+1}（事件 ${e.eventIds[0]} → ${e.eventIds[1]}）：${e.message.slice(0,60)}…`);'
CNT_AFTER="$(get_ed "$BASE/api/editor/routes" | jfield 'd.routes.length')"
[ "$CNT_BEFORE" = "$CNT_AFTER" ] && echo "OK：断点路线未保存（仍 $CNT_AFTER 条路线）" || { echo "FAIL：断点路线被保存"; exit 1; }

say "8) 冻结验证：改草稿（删首条关系、改首事件标题）并发布第 2 版，旧路线逐字节不变"
get_ed "$BASE/api/editor/routes/1/raw" | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
require("fs").writeFileSync(process.argv[1], JSON.stringify(d.route));' /tmp/rlc-route-before.json
REL1="$(get_ed "$BASE/api/editor/state" | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const first=Number(process.argv[1]);
process.stdout.write(String(d.relations.find(r=>r.earlierId===first).id));' "$FIRST")"
curl -s -X DELETE "${h_ed[@]}" "$BASE/api/editor/relations/$REL1" >/dev/null
curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/events/$FIRST" \
  -d '{"title":"长链路线示例第1日（草稿改名）'"$TS"'","description":""}' >/dev/null
printf '%s' "{\"selection\":$SEL,\"baseVersionNo\":$V1,\"editor\":\"长链路线示例\",\"note\":\"第二版 $TS\"}" \
  | post "$BASE/api/editor/publish" -d @- | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error("发布第 2 版失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
console.log(`OK：已发布第 ${d.versionNo} 版（草稿已删首条关系并改首事件标题）`);'
get_ed "$BASE/api/editor/routes/1/raw" | node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync(0,"utf8"));
const before=fs.readFileSync("/tmp/rlc-route-before.json","utf8");
if(JSON.stringify(d.route)!==before){console.error("FAIL：旧路线被草稿改动影响");process.exit(1);}
console.log("OK：改草稿、发新版后路线 #1 逐字节不变（仍据第 "+d.route.versionNo+" 版快照）");'

say "9) 出处遮盖：遮盖链上第 100 个事件的主张出处 → 访客见「出处已遮盖」，编辑者看原文"
EV100="$(sed -n '100p' "$IDS_FILE" | cut -f1)"
SRC100="长链路线示例口述第100册 $TS"
PREV="$(post "$BASE/api/editor/redaction-preview" -d "{\"source\":\"$SRC100\"}")"
CVN="$(printf '%s' "$PREV" | jfield 'd.currentVersionNo')"
post "$BASE/api/editor/redaction" -d "{\"source\":\"$SRC100\",\"currentVersionNo\":$CVN,\"editor\":\"长链路线示例\"}" \
  | jfield 'd.ok' >/dev/null
get_pub "$BASE/api/public/routes/1" | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const ev100=d.route.events.find(e=>e.eventId===Number(process.argv[1]));
const ev101=d.route.events.find(e=>e.eventId===Number(process.argv[2]));
console.log(`访客视图：事件 100 出处=「${ev100.source}」；事件 101 出处=「${ev101.source.slice(0,24)}…」`);
if(ev100.source!=="出处已遮盖"){console.error("FAIL：命中处未遮盖");process.exit(1);}' "$EV100" "$((EV100 + 1))"
get_ed "$BASE/api/editor/routes/1/raw" | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const ev100=d.route.events.find(e=>e.eventId===Number(process.argv[1]));
console.log(`编辑者原文视图：事件 100 出处=「${ev100.source}」`);
if(ev100.source==="出处已遮盖"){console.error("FAIL：编辑者原文被遮盖");process.exit(1);}' "$EV100"

say "10) 撤回所据版本：访客路线隐藏（404 / 清单不含），编辑者仍可见原文"
post "$BASE/api/editor/versions/$V1/retract" \
  -d '{"reason":"长链路线示例：编年依据待核","editor":"长链路线示例"}' | jfield 'd.ok' >/dev/null
code=$(http_code "$BASE/api/public/routes/1")
[ "$code" = 404 ] && echo "OK：访客读引用撤回版的路线 → 404" || { echo "FAIL：期望 404，实际 $code"; exit 1; }
PUB_CNT="$(get_pub "$BASE/api/public/routes" | jfield 'd.routes.length')"
[ "$PUB_CNT" = 0 ] && echo "OK：访客路线清单不含引用撤回版的路线" || { echo "FAIL：访客清单仍含撤回版路线"; exit 1; }
get_ed "$BASE/api/editor/routes/1/raw" | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(d.versionRetracted!==true){console.error("FAIL：缺少 versionRetracted 标记");process.exit(1);}
console.log(`OK：编辑者仍可见路线原文（versionRetracted=${d.versionRetracted}，链上事件 ${d.route.events.length} 个）`);'
echo "访客当前年表版本 = $(get_pub "$BASE/api/public/chronicle" | jfield 'd.currentVersionNo')（第 $V1 版已撤回，指向最大未撤回版）"

rm -f "$IDS_FILE" /tmp/rlc-route-before.json
say "全部通过 ✅"
echo "长链路线要点：每段仍是关系数最少的见证链（同长度按关系 ID 序列字典序择小），"
echo "求解为线性实现（正/反向 BFS 定层 + 逐层最小关系 ID 贪心 + 父指针回溯），不逐层复制路径；"
echo "断点整条拒绝且不保存；路线建立即冻结（版本号 / 锚点顺序 / 各段见证链），"
echo "改草稿、发新版不影响旧路线；访客按出处遮盖与撤回版隐藏规则读取，编辑者看原文。"
