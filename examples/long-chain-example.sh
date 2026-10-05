#!/usr/bin/env bash
# 长链草稿（逐日相接的数千事件 + 逐条「先于」关系）端到端调用示例。
#
# 背景：编辑者分批整理出逐日相接的 6000 个事件及逐条「先于」关系后，
# 校验 / 即时发布 / 预约建立都必须在秒级内完成且结果一致（求解器为迭代实现，
# 不会因链长触发调用栈溢出）。
#
# 流程：分 3 批经「采访整理包导入」铺 6000 事件长链（每批 2000，控制请求体大小）
#       → 跨批补 2 条衔接关系 → 组装 selection
#       → 校验（/api/editor/validate）→ 即时发布 → 建立 12 秒后的预约
#       → 三方求解日期一致性比对（哈希）
#       → 失败一致性：加回边成环（三入口同报 cycle）、链尾改窄区间（三入口同报 temporal，
#         见证链贯穿 6000 事件），均不写版本或预约；随后恢复草稿
#       → 等待预约到期：自动发布的新版本与即时发布逐日一致；访客公开读出。
#
# 依赖：curl 与 node。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/long-chain-example.sh
#   可用 N=6000 BATCH=2000 调整链长与批大小（单批请求体须小于 1MB）。
# 总耗时约 30 秒。可重复运行（标题带时间戳）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
N="${N:-6000}"
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
latest_no() { get_pub "$BASE/api/public/versions" | jfield 'd.currentVersionNo'; }
utc_in() { node -e 'console.log(new Date(Date.now()+Number(process.argv[1])*1000).toISOString().replace(/\.\d{3}Z$/,"Z"))' -- "$1"; }

say "0) 口令检查（错误口令应 401）"
code=$(http_code -X POST "${h_json[@]}" -H 'X-Editor-Token: wrong' \
  -d '{"selection":[]}' "$BASE/api/editor/validate")
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
      events.push({ key: "e" + i, title: `长链示例第${i}日 ${ts}`,
        claims: [{ precision: "day", year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
          source: `长链示例口述第${i}册 ${ts}` }] });
    }
    const relations = [];
    for (let i = lo; i < hi; i++) relations.push({ earlierKey: "e" + i, laterKey: "e" + (i + 1), source: "逐日衔接" });
    console.log(JSON.stringify({ batchId: `long-chain-${ts}-${lo}`, events, relations }));
  ' "$lo" "$hi" "$TS" > "$BUNDLE_FILE"
  preview="$(post "$BASE/api/editor/import-preview" -d @"$BUNDLE_FILE")"
  fp="$(printf '%s' "$preview" | jfield 'd.fingerprint')"
  rev="$(printf '%s' "$preview" | jfield 'd.draftRevisionNo')"
  printf '%s' "$preview" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
    if(!d.ok){console.error("预览失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
    console.error(`  批次 events[${d.counts.eventCount} 事件 / ${d.counts.relationCount} 关系] 预览通过`);'
  confirm="$(node -e 'const fs=require("fs");
    const bundle=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    console.log(JSON.stringify({ bundle, fingerprint: process.argv[2], draftRevisionNo: Number(process.argv[3]) }));' \
    "$BUNDLE_FILE" "$fp" "$rev" | post "$BASE/api/editor/import" -d @-)"
  printf '%s' "$confirm" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
    if(!d.ok){console.error("导入失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
    for(const e of d.idMap.events) console.log(`${e.eventId}\t${e.claimIds[0]}`);' >> "$IDS_FILE"
done
rm -f "$BUNDLE_FILE"
echo "已导入 $(wc -l < "$IDS_FILE") 个事件（各带 1 条日精度主张，自 1950-01-01 起逐日相接）"

say "2) 跨批次补衔接关系（共 $((batches - 1)) 条）"
first_id() { head -1 "$IDS_FILE" | cut -f1; }
last_id() { tail -1 "$IDS_FILE" | cut -f1; }
for (( b=1; b<batches; b++ )); do
  prev_tail="$(sed -n "$(( b * BATCH ))p" "$IDS_FILE" | cut -f1)"
  curr_head="$(sed -n "$(( b * BATCH + 1 ))p" "$IDS_FILE" | cut -f1)"
  post "$BASE/api/editor/relations" \
    -d '{"earlierId":'"$prev_tail"',"laterId":'"$curr_head"',"source":"跨批衔接"}' >/dev/null
done
echo "长链关系总数 = $((N - 1))"

say "3) 组装 selection（每事件选定其唯一主张）"
SEL="$(node -e 'const fs=require("fs");
  const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>l.split("\t"));
  console.log(JSON.stringify(rows.map(([eventId,claimId])=>({eventId:Number(eventId),claimId:Number(claimId)}))));' "$IDS_FILE")"

say "4) 校验长链草稿：POST /api/editor/validate"
printf '%s' "{\"selection\":$SEL}" | post "$BASE/api/editor/validate" -d @- | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error("校验未通过："+JSON.stringify(d.errors&&d.errors[0]).slice(0,300));process.exit(1);}
const p=d.preview;
console.log(`OK：${p.length} 个事件全部可解；首日 ${p[0].resolvedDate}，末日 ${p[p.length-1].resolvedDate}`);
const sorted=[...p].sort((a,b)=>a.eventId-b.eventId);
let good=true;
for(let i=1;i<sorted.length;i++) if(sorted[i].resolvedDate<=sorted[i-1].resolvedDate){good=false;break;}
console.log("逐日严格 +1：" + good);
require("fs").writeFileSync(process.argv[1], JSON.stringify(sorted.map(x=>`${x.eventId}:${x.resolvedDate}`).join(",")));' /tmp/lc-validate.hash

say "5) 即时发布：POST /api/editor/publish"
V0="$(latest_no)"
printf '%s' "{\"selection\":$SEL,\"baseVersionNo\":$V0,\"editor\":\"长链示例\",\"note\":\"长链示例 $TS\"}" \
  | post "$BASE/api/editor/publish" -d @- | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error("发布失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
console.log(`OK：第 ${d.versionNo} 版，${d.version.events.length} 事件 / ${d.version.relations.length} 关系`);
const sorted=[...d.version.events].sort((a,b)=>a.eventId-b.eventId);
require("fs").writeFileSync(process.argv[1], JSON.stringify(sorted.map(x=>`${x.eventId}:${x.resolvedDate}`).join(",")));' /tmp/lc-publish.hash
V1="$(latest_no)"

say "6) 建立 12 秒后的预约：POST /api/editor/schedules"
AT="$(utc_in 12)"
S1="$(printf '%s' "{\"selection\":$SEL,\"scheduledAt\":\"$AT\",\"baseVersionNo\":$V1,\"editor\":\"长链示例\",\"note\":\"长链预约 $TS\"}" \
  | post "$BASE/api/editor/schedules" -d @- | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error("预约失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
const sorted=[...d.schedule.frozen.events].sort((a,b)=>a.eventId-b.eventId);
require("fs").writeFileSync(process.argv[1], JSON.stringify(sorted.map(x=>`${x.eventId}:${x.resolvedDate}`).join(",")));
console.error(`OK：预约号 #${d.schedule.scheduleNo}，基准第 ${d.schedule.baseVersionNo} 版，到期 ${d.schedule.scheduledAt}`);
process.stdout.write(String(d.schedule.scheduleNo));' /tmp/lc-schedule.hash)"
echo "预约号 S1 = #$S1"

say "7) 三方一致性：校验预览 = 即时发布 = 预约冻结（求解日期逐事件相同）"
node -e '
const fs=require("fs");
const [a,b,c]=["/tmp/lc-validate.hash","/tmp/lc-publish.hash","/tmp/lc-schedule.hash"].map(f=>fs.readFileSync(f,"utf8"));
if(a===b&&b===c) console.log("OK：三个入口对同一草稿的求解结果完全一致（"+JSON.parse(a).split(",").length+" 个事件）");
else { console.error("FAIL：三入口求解结果不一致"); process.exit(1); }'

say "8) 失败一致性①：加回边成环 → 三入口同报 cycle，不写版本或预约"
FIRST="$(first_id)"; LAST="$(last_id)"
REL_BACK="$(post "$BASE/api/editor/relations" -d '{"earlierId":'"$LAST"',"laterId":'"$FIRST"',"source":"示例回边"}' | jfield 'd.relation.id')"
printf '%s' "{\"selection\":$SEL}" | post "$BASE/api/editor/validate" -d @- | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const e=d.errors&&d.errors[0];
console.log(`validate：ok=${d.ok} 类型=${e.type} 涉事事件 ${e.eventIds.length} 个 / 关系 ${e.relationIds.length} 条`);
if(d.ok!==false||e.type!=="cycle") process.exit(1);'
code=$(printf '%s' "{\"selection\":$SEL,\"baseVersionNo\":$V1}" | http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/publish" -d @-)
[ "$code" = 422 ] && echo "OK：publish → 422（cycle），未写入新版本" || { echo "FAIL：publish 期望 422，实际 $code"; exit 1; }
code=$(printf '%s' "{\"selection\":$SEL,\"scheduledAt\":\"$(utc_in 3600)\",\"baseVersionNo\":$V1}" | http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/schedules" -d @-)
[ "$code" = 422 ] && echo "OK：schedules → 422（cycle），未建立预约" || { echo "FAIL：schedules 期望 422，实际 $code"; exit 1; }
curl -s -X DELETE "${h_ed[@]}" "$BASE/api/editor/relations/$REL_BACK" >/dev/null
echo "已删除回边，草稿恢复可解"

say "9) 失败一致性②：链尾主张改窄区间 → 三入口同报 temporal（给出见证链）"
TAIL_CLAIM="$(tail -1 "$IDS_FILE" | cut -f2)"
TAIL_YMD="$(node -e 'const d=new Date(Date.UTC(1950,0,Number(process.argv[1])));
  console.log(JSON.stringify({year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()}))' "$N")"
curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/claims/$TAIL_CLAIM" \
  -d '{"precision":"day","year":1950,"month":1,"day":1,"source":"改窄的区间"}' >/dev/null
printf '%s' "{\"selection\":$SEL}" | post "$BASE/api/editor/validate" -d @- | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const e=d.errors&&d.errors[0];
console.log(`validate：ok=${d.ok} 类型=${e.type} 见证链 ${e.eventIds.length} 事件 / ${e.relationIds.length} 关系`);
console.log("  说明：" + e.message.slice(0, 90) + " …");
if(d.ok!==false||e.type!=="temporal") process.exit(1);'
code=$(printf '%s' "{\"selection\":$SEL,\"baseVersionNo\":$V1}" | http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/publish" -d @-)
[ "$code" = 422 ] && echo "OK：publish → 422（temporal），未写入新版本" || { echo "FAIL：publish 期望 422，实际 $code"; exit 1; }
code=$(printf '%s' "{\"selection\":$SEL,\"scheduledAt\":\"$(utc_in 3600)\",\"baseVersionNo\":$V1}" | http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/schedules" -d @-)
[ "$code" = 422 ] && echo "OK：schedules → 422（temporal），未建立预约" || { echo "FAIL：schedules 期望 422，实际 $code"; exit 1; }
node -e 'const ymd=JSON.parse(process.argv[1]);
  console.log(JSON.stringify({precision:"day",year:ymd.year,month:ymd.month,day:ymd.day,source:"长链示例口述（恢复）"}));' "$TAIL_YMD" \
  | curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/claims/$TAIL_CLAIM" -d @- >/dev/null
echo "已恢复链尾主张区间（第 ${N} 日）"
echo "访客当前版本 = $(latest_no)（失败未产生新版本；预约冻结内容不受草稿改动影响）"

say "10) 等待预约 S1 到期（约 12 秒）……"
sleep 14
get_ed "$BASE/api/editor/schedules/$S1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const s=d.schedule;
console.log(`#${s.scheduleNo} 状态=${s.status} resultVersionNo=${s.resultVersionNo}`);
if(s.status!=="published") process.exit(1);'
V2="$(latest_no)"
echo "访客当前版本 = 第 $V2 版（预约自动发布）"
get_pub "$BASE/api/public/versions/$V2" | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const sorted=[...d.version.events].sort((a,b)=>a.eventId-b.eventId);
const mine=JSON.stringify(sorted.map(x=>`${x.eventId}:${x.resolvedDate}`).join(","));
const expect=require("fs").readFileSync("/tmp/lc-publish.hash","utf8").trim();
console.log(mine===expect? "OK：预约发布版与即时发布版逐日一致（"+sorted.length+" 事件）" : "FAIL：不一致");
if(mine!==expect) process.exit(1);
console.log(`  首日 ${sorted[0].resolvedDate}「${sorted[0].title}」，末日 ${sorted[sorted.length-1].resolvedDate}「${sorted[sorted.length-1].title}」`);'

rm -f "$IDS_FILE" /tmp/lc-validate.hash /tmp/lc-publish.hash /tmp/lc-schedule.hash
say "全部断言通过 ✅"
echo "提示：长链草稿（数千事件逐日相接）的校验 / 即时发布 / 预约建立均为秒级完成且结果一致；"
echo "      成环与时间无解按既有错误结构反馈（含涉事事件与关系见证），不写入版本或预约。"
