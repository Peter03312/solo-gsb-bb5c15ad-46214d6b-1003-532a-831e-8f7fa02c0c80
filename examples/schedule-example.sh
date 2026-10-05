#!/usr/bin/env bash
# 预约发布（scheduled publishing）端到端调用示例。
#
# 流程：建草稿并发布首版（访客旧版）
#       → 建立 12 秒后的预约（冻结内容，校验时间/主张/基准）
#       → 查看预约列表 / 详情；改草稿（证明预约内容不变）
#       → 等待到期：自动生成第 2 版，访客切换
#       → 再建两条预约：期间即时发布第 3 版，到期一条发布、一条冲突
#       → 取消待执行预约；非法时间 400、校验不过 422、基准过期 409、已执行不可取消 409。
#
# 依赖：curl 与 node。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/schedule-example.sh
# 总耗时约 25 秒。可重复运行（标题带时间戳）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
del() { curl -s -X DELETE "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
get_pub() { curl -s "$@"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
latest_no() { get_pub "$BASE/api/public/versions" | jfield 'd.currentVersionNo'; }
# 用法：utc_in <秒数>  → 未来 N 秒的规范 UTC 串
utc_in() { node -e 'console.log(new Date(Date.now()+Number(process.argv[1])*1000).toISOString().replace(/\.\d{3}Z$/,"Z"))' -- "$1"; }

say "0) 口令检查（错误口令应 401）"
code=$(http_code -X POST "${h_json[@]}" -H 'X-Editor-Token: wrong' \
  -d '{"selection":[],"scheduledAt":"2099-01-01T00:00:00Z"}' "$BASE/api/editor/schedules")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 建草稿：2 事件 + 主张 + 先于关系，即时发布首版"
E1=$(post "$BASE/api/editor/events" -d '{"title":"预约示例动员会 '$TS'"}' | jfield 'd.event.id')
E2=$(post "$BASE/api/editor/events" -d '{"title":"预约示例通水会 '$TS'"}' | jfield 'd.event.id')
C1=$(post "$BASE/api/editor/events/$E1/claims" \
  -d '{"precision":"day","year":1958,"month":9,"day":12,"source":"李宝山口述 '$TS'"}' | jfield 'd.claim.id')
C2=$(post "$BASE/api/editor/events/$E2/claims" \
  -d '{"precision":"month","year":1959,"month":5,"source":"王秀兰口述 '$TS'"}' | jfield 'd.claim.id')
post "$BASE/api/editor/relations" -d '{"earlierId":'"$E1"',"laterId":'"$E2"',"source":"二人口述一致 '$TS'"}' >/dev/null
SEL='[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'}]'
V0="$(latest_no)"
post "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL"',"baseVersionNo":'"$V0"',"editor":"示例脚本","note":"预约示例首版"}' >/dev/null
V1="$(latest_no)"
echo "首版 = 第 $V1 版；访客当前见第 $V1 版"

say "2) 非法时间 / 过去时刻 → 400，不建立预约"
for BAD in 'not-time' '2026-10-02T12:00' '2026-10-02T12:00:00+08:00' "$(utc_in -60)"; do
  code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/schedules" \
    -d '{"selection":'"$SEL"',"scheduledAt":"'"$BAD"'","baseVersionNo":'"$V1"'}')
  [ "$code" = 400 ] && echo "OK：[$BAD] → 400" || { echo "FAIL：[$BAD] 期望 400，实际 $code"; exit 1; }
done

say "3) 草稿校验不过（冬月先于春月无解）→ 422，不建立预约"
EX1=$(post "$BASE/api/editor/events" -d '{"title":"示例冬月 '$TS'"}' | jfield 'd.event.id')
EX2=$(post "$BASE/api/editor/events" -d '{"title":"示例春月 '$TS'"}' | jfield 'd.event.id')
CX1=$(post "$BASE/api/editor/events/$EX1/claims" -d '{"precision":"month","year":1958,"month":12,"source":"x"}' | jfield 'd.claim.id')
CX2=$(post "$BASE/api/editor/events/$EX2/claims" -d '{"precision":"month","year":1958,"month":1,"source":"x"}' | jfield 'd.claim.id')
post "$BASE/api/editor/relations" -d '{"earlierId":'"$EX1"',"laterId":'"$EX2"'}' >/dev/null
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/schedules" \
  -d '{"selection":[{"eventId":'"$EX1"',"claimId":'"$CX1"'},{"eventId":'"$EX2"',"claimId":'"$CX2"'}],"scheduledAt":"'"$(utc_in 60)"'","baseVersionNo":'"$V1"'}')
[ "$code" = 422 ] && echo "OK：无解草稿 → 422" || { echo "FAIL：期望 422，实际 $code"; exit 1; }
# 清理这两个示例事件（它们会级联删除主张/关系，不影响主流程；仍只选 E1/E2）
curl -s -X DELETE "${h_ed[@]}" "$BASE/api/editor/events/$EX1" >/dev/null
curl -s -X DELETE "${h_ed[@]}" "$BASE/api/editor/events/$EX2" >/dev/null

say "4) baseVersionNo 过期 → 409，不建立预约"
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/schedules" \
  -d '{"selection":'"$SEL"',"scheduledAt":"'"$(utc_in 60)"'","baseVersionNo":999}')
[ "$code" = 409 ] && echo "OK：基准过期 → 409" || { echo "FAIL：期望 409，实际 $code"; exit 1; }

say "5) 建立 12 秒后的预约：冻结内容（事件/主张/关系/求解日期/基准版本号）"
AT1="$(utc_in 12)"
S1=$(post "$BASE/api/editor/schedules" \
  -d '{"selection":'"$SEL"',"scheduledAt":"'"$AT1"'","baseVersionNo":'"$V1"',"editor":"示例脚本","note":"预约示例第二版"}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok) { console.error(JSON.stringify(d)); process.exit(1); }
console.error("OK scheduleNo =", d.schedule.scheduleNo, " 状态 =", d.schedule.status,
  " 冻结基准 =", d.schedule.baseVersionNo, " 求解日期 =", d.schedule.frozen.events.map(e=>e.resolvedDate).join(","));
process.stdout.write(String(d.schedule.scheduleNo));')
echo "预约号 S1 = #$S1，到期时刻 $AT1"

say "6) 之后修改草稿（改标题）不影响预约；到期前访客只见旧版"
curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/events/$E1" \
  -d '{"title":"改过的标题 '$TS'","description":""}' >/dev/null
echo "访客当前版本 = $(latest_no)（仍为第 $V1 版）"
get_ed "$BASE/api/editor/schedules/$S1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("预约冻结标题 =", d.schedule.frozen.events.map(e=>e.title).join(","), "（仍是旧标题）");'

say "7) 再建立 20 秒后的预约 S2（稍后将被即时发布抢先 → 到期冲突）"
AT2="$(utc_in 20)"
S2=$(post "$BASE/api/editor/schedules" \
  -d '{"selection":'"$SEL"',"scheduledAt":"'"$AT2"'","baseVersionNo":'"$V1"',"note":"将冲突的预约"}' \
  | jfield 'd.schedule.scheduleNo')
echo "S2 = #$S2，到期时刻 $AT2"

say "8) 工作台列表：pending 在前、按到期时刻升序"
get_ed "$BASE/api/editor/schedules" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
for (const s of d.schedules.filter(x=>x.status==="pending"))
  console.log(`  #${s.scheduleNo} [${s.status}] ${s.scheduledAt} 基准第${s.baseVersionNo}版 ${s.eventCount}事件`);'

say "9) 等待 S1 到期（约 12 秒）……"
sleep 14
get_ed "$BASE/api/editor/schedules/$S1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const s=d.schedule;
console.log(`#${s.scheduleNo} 状态=${s.status} resultVersionNo=${s.resultVersionNo}`);
if(s.status!=="published") process.exit(1);'
echo "访客当前版本 = $(latest_no)（应为第 $((V1+1)) 版，内容来自冻结快照）"
get_pub "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
for (const e of d.version.events) console.log(`  ${e.resolvedDate} 「${e.title}」 出处=${e.source}`);
console.log("  关系数 =", d.version.relations.length);'

say "10) S1 已生效不能取消 → 409；重复触发不产生新版本"
code=$(http_code -X DELETE "${h_ed[@]}" "$BASE/api/editor/schedules/$S1")
[ "$code" = 409 ] && echo "OK：已生效预约取消返回 409" || { echo "FAIL：期望 409，实际 $code"; exit 1; }

say "11) S2 到期前即时发布第 3 版（抢先）→ S2 到期标记冲突、保留内容、不改基准"
V2="$(latest_no)"
post "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL"',"baseVersionNo":'"$V2"',"editor":"插队者","note":"抢先发布使 S2 基准过期"}' >/dev/null
V3="$(latest_no)"
echo "已即时发布第 $V3 版；等待 S2 到期……"
sleep 10
get_ed "$BASE/api/editor/schedules/$S2" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const s=d.schedule;
console.log(`#${s.scheduleNo} 状态=${s.status}`);
console.log("说明：", s.resultMessage);
console.log("冻结内容仍可查看：事件", s.frozen.events.length, "个，关系", s.frozen.relations.length, "条");
if(s.status!=="conflict") process.exit(1);'
echo "访客当前版本 = $(latest_no)（仍为第 $V3 版，冲突预约没有多出版本）"

say "12) 取消尚未执行的预约（新建一个远期的再取消；重复取消幂等 200）"
S3=$(post "$BASE/api/editor/schedules" \
  -d '{"selection":'"$SEL"',"scheduledAt":"'"$(utc_in 3600)"'","baseVersionNo":'"$V3"'}' \
  | jfield 'd.schedule.scheduleNo')
del "$BASE/api/editor/schedules/$S3" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("首次取消：", d.cancelled, " 状态 =", d.schedule.status);
if(d.schedule.status!=="cancelled") process.exit(1);'
del "$BASE/api/editor/schedules/$S3" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("重复取消：alreadyCancelled =", d.alreadyCancelled, "（幂等 200）");
if(d.alreadyCancelled!==true) process.exit(1);'

say "13) 最终预约总览"
get_ed "$BASE/api/editor/schedules" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
for (const s of d.schedules)
  console.log(`  #${s.scheduleNo} [${s.status.padEnd(9)}] ${s.scheduledAt} 基准第${s.baseVersionNo}版` +
    (s.resultVersionNo ? ` → 第${s.resultVersionNo}版` : ""));'

say "全部断言通过 ✅"
echo "提示：$BASE/editor 的「发布」卡片可图形化建立/查看/取消预约；访客年表 $BASE/ 始终只见已发布版本。"
