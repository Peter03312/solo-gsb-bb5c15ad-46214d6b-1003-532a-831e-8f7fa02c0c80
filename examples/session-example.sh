#!/usr/bin/env bash
# 并行编辑会话（edit session）端到端调用示例。
#
# 场景：两名编辑者并行整理同一份年表草稿——
#   1) 甲直接编辑草稿建好底稿（2 事件 + 主张 + 先于关系）
#   2) 甲、乙各自开启编辑会话（记录当时的草稿修订号与基线快照）
#   3) 甲在会话内暂存一批操作并提交：原子应用，返回新修订号与临时编号映射
#   4) 重试同一提交：幂等返回首次结果，不重复写入
#   5) 乙的会话与甲改了同一事件的不同字段：自动合并，互不覆盖
#   6) 同一字段被双方改成不同值：整次拒绝（409），逐项列出基线/当前值/拟提交值
#   7) 编辑与删除相撞、关系端点已删除：同样整次拒绝
#   8) 冲突后基于最新草稿重开会话，人工重编后提交成功
#   9) 会话内容仅持编辑口令可见，访客不可见
#
# 依赖：curl 与 node。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/session-example.sh
# 总耗时约 5 秒。可重复运行（标题带时间戳）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

say "0) 口令检查（无口令 / 错误口令应 401）"
code=$(http_code "$BASE/api/editor/sessions")
[ "$code" = 401 ] && echo "OK：无口令访问会话列表 → 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }
code=$(http_code -X POST "${h_json[@]}" -H 'X-Editor-Token: wrong' "$BASE/api/editor/sessions" -d '{}')
[ "$code" = 401 ] && echo "OK：错误口令开启会话 → 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 甲直接编辑草稿，建好底稿（2 事件 + 主张 + 先于关系）"
E1=$(post "$BASE/api/editor/events" -d '{"title":"修水渠动员会 '$TS'","description":"晒谷场开会"}' | jfield 'd.event.id')
E2=$(post "$BASE/api/editor/events" -d '{"title":"东干渠通水 '$TS'"}' | jfield 'd.event.id')
C1=$(post "$BASE/api/editor/events/$E1/claims" \
  -d '{"precision":"day","year":1958,"month":9,"day":12,"source":"李宝山口述 '$TS'"}' | jfield 'd.claim.id')
C2=$(post "$BASE/api/editor/events/$E2/claims" \
  -d '{"precision":"month","year":1959,"month":5,"source":"王秀兰口述 '$TS'"}' | jfield 'd.claim.id')
R1=$(post "$BASE/api/editor/relations" -d '{"earlierId":'"$E1"',"laterId":'"$E2"',"source":"二人口述一致 '$TS'"}' | jfield 'd.relation.id')
REV0=$(get_ed "$BASE/api/editor/state" | jfield 'd.draftRevisionNo')
echo "底稿完成：事件 $E1 / $E2，主张 $C1 / $C2，关系 $R1，草稿修订号 $REV0"

say "2) 甲、乙各自开启编辑会话（记录当时的草稿修订号与基线快照）"
SA=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲"}' | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.error(`甲的会话 #${d.session.sessionId}：基线修订号 ${d.session.baseRevisionNo}，快照 ${d.session.baseline.counts.eventCount} 事件 / ${d.session.baseline.counts.claimCount} 主张 / ${d.session.baseline.counts.relationCount} 关系`);
process.stdout.write(String(d.session.sessionId));')
SB=$(post "$BASE/api/editor/sessions" -d '{"editor":"乙"}' | jfield 'd.session.sessionId')
echo "乙的会话 #$SB（同一基线修订号 $REV0）"

say "3) 甲在会话内暂存一批操作（新事件用临时编号互相引用），提交后原子应用"
post "$BASE/api/editor/sessions/$SA/ops" -d '{"ops":[
  {"op":"create_event","tempId":"chou-shui-ji","title":"抽水机到站 '$TS'","description":"县里调拨"},
  {"op":"create_claim","tempId":"csj-c1","eventRef":"chou-shui-ji","precision":"year","year":1962,"source":"张德福口述 '$TS'"},
  {"op":"create_relation","tempId":"csj-r1","earlierId":'"$E2"',"laterRef":"chou-shui-ji","source":"先有水渠后有抽水机"},
  {"op":"update_event","eventId":'"$E1"',"description":"晒谷场开会，甲补充：到会约两百人"},
  {"op":"update_claim","claimId":'"$C2"',"note":"甲加的考异：另有 1959 年 6 月说"}
]}' | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error(JSON.stringify(d));process.exit(1)}
console.log(`已暂存 ${d.staged} 条；工作稿预览：${d.working.counts.eventCount} 事件 / ${d.working.counts.claimCount} 主张 / ${d.working.counts.relationCount} 关系（草稿尚未变化）`);'
REV_BEFORE=$(get_ed "$BASE/api/editor/state" | jfield 'd.draftRevisionNo')
post "$BASE/api/editor/sessions/$SA/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error(JSON.stringify(d));process.exit(1)}
console.log(`提交成功：新草稿修订号 ${d.revisionNo}`);
console.log("临时编号 → 正式编号：",
  d.idMap.events.map(m=>`${m.tempId}→事件#${m.eventId}`).join(", "),
  d.idMap.claims.map(m=>`${m.tempId}→主张#${m.claimId}`).join(", "),
  d.idMap.relations.map(m=>`${m.tempId}→关系#${m.relationId}`).join(", "));
console.log("应用明细：", JSON.stringify(d.applied));'
REV_AFTER=$(get_ed "$BASE/api/editor/state" | jfield 'd.draftRevisionNo')
[ "$REV_AFTER" = "$((REV_BEFORE+1))" ] && echo "OK：整次提交只推进一次修订号（$REV_BEFORE → $REV_AFTER）" || { echo "FAIL：修订号 $REV_BEFORE → $REV_AFTER"; exit 1; }

say "4) 重试同一提交：幂等返回首次结果，不重复写入"
post "$BASE/api/editor/sessions/$SA/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log(`alreadyCommitted = ${d.alreadyCommitted}，revisionNo = ${d.revisionNo}（与首次相同）`);
if(d.alreadyCommitted!==true) process.exit(1);'
CNT=$(get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
process.stdout.write(String(d.events.filter(e=>e.title.startsWith("抽水机到站")).length))')
[ "$CNT" = "1" ] && echo "OK：新事件只写入一次" || { echo "FAIL：重复写入"; exit 1; }
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/sessions/$SA/ops" -d '{"ops":[{"op":"create_event","tempId":"x","title":"t"}]}')
[ "$code" = 409 ] && echo "OK：已关闭会话不能再暂存 → 409" || { echo "FAIL：期望 409，实际 $code"; exit 1; }

say "5) 乙的会话与甲改了同一事件的不同字段：自动合并，互不覆盖"
# 乙的会话基线里事件 E1 的描述还是旧的；乙只改标题
post "$BASE/api/editor/sessions/$SB/ops" -d '{"ops":[
  {"op":"update_event","eventId":'"$E1"',"title":"修水渠动员会（乙校订）'$TS'"}
]}' >/dev/null
post "$BASE/api/editor/sessions/$SB/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error(JSON.stringify(d));process.exit(1)}
console.log("乙提交成功；自动合并记录：", JSON.stringify(d.autoMerged));'
get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const e=d.events.find(x=>x.title.includes("乙校订"));
console.log(`合并结果：标题=「${e.title}」（乙改的字段），描述=「${e.description}」（甲改的字段，未被覆盖）`);
if(!e.description.includes("甲补充")) process.exit(1);'

say "6) 同一字段被双方改成不同值：整次拒绝，逐项列出基线/当前值/拟提交值"
SC=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲"}' | jfield 'd.session.sessionId')
SD=$(post "$BASE/api/editor/sessions" -d '{"editor":"乙"}' | jfield 'd.session.sessionId')
post "$BASE/api/editor/sessions/$SC/ops" -d '{"ops":[{"op":"update_event","eventId":'"$E2"',"title":"东干渠通水（甲定稿）'$TS'"}]}' >/dev/null
post "$BASE/api/editor/sessions/$SD/ops" -d '{"ops":[{"op":"update_event","eventId":'"$E2"',"title":"东干渠通水（乙定稿）'$TS'"}]}' >/dev/null
post "$BASE/api/editor/sessions/$SC/commit" | jfield 'd.revisionNo' >/dev/null
echo "甲的会话 #$SC 先提交成功；乙的会话 #$SD 后提交应冲突："
code=$(http_code -X POST "${h_ed[@]}" "$BASE/api/editor/sessions/$SD/commit")
[ "$code" = 409 ] && echo "OK：后提交者 → 409 SESSION_MERGE_CONFLICT" || { echo "FAIL：期望 409，实际 $code"; exit 1; }
post "$BASE/api/editor/sessions/$SD/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const c=d.conflicts[0];
console.log(`冲突类型：${c.type}（${d.code}，重复提交同样 409 且 alreadyConflicted=${d.alreadyConflicted}）`);
for(const f of c.fields) console.log(`  字段 ${f.field}：基线「${f.baseline}」/ 当前「${f.current}」/ 拟提交「${f.proposed}」`);'
get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const e=d.events.find(x=>x.title.includes("通水"));
console.log(`草稿仍是甲的定稿：「${e.title}」（乙的拟提交未覆盖甲）`);
if(!e.title.includes("甲定稿")) process.exit(1);'

say "7) 编辑与删除相撞 / 关系端点已删除：同样整次拒绝"
SE=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲"}' | jfield 'd.session.sessionId')
post "$BASE/api/editor/sessions/$SE/ops" -d '{"ops":[{"op":"delete_event","eventId":'"$E2"'}]}' >/dev/null
curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/events/$E2" \
  -d '{"title":"东干渠通水（乙又改了）'"$TS"'","description":""}' >/dev/null
code=$(http_code -X POST "${h_ed[@]}" "$BASE/api/editor/sessions/$SE/commit")
[ "$code" = 409 ] && echo "OK：会话删除 vs 对方修改 → 409（edit_delete）" || { echo "FAIL：期望 409，实际 $code"; exit 1; }

SF=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲"}' | jfield 'd.session.sessionId')
post "$BASE/api/editor/sessions/$SF/ops" -d '{"ops":[
  {"op":"create_relation","tempId":"rr","earlierId":'"$E1"',"laterId":'"$E2"',"source":"会话内新增关系"}
]}' >/dev/null
# 对方直接删除端点事件 E2（其上的主张与关系随之级联删除）
curl -s -X DELETE "${h_ed[@]}" "$BASE/api/editor/events/$E2" >/dev/null
post "$BASE/api/editor/sessions/$SF/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(d.status!==409||d.code!=="SESSION_MERGE_CONFLICT"){console.error(JSON.stringify(d));process.exit(1)}
const c=d.conflicts.find(x=>x.type==="endpoint_deleted");
console.log(`OK：关系端点已删除 → 409（${c.message}）`);'

say "8) 冲突后基于最新草稿重开会话：人工重编后提交成功"
SG=$(post "$BASE/api/editor/sessions" -d '{"editor":"乙"}' | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.error(`乙重开会话 #${d.session.sessionId}：基线修订号 ${d.session.baseRevisionNo}（含甲的最新改动）`);
process.stdout.write(String(d.session.sessionId));')
post "$BASE/api/editor/sessions/$SG/ops" -d '{"ops":[
  {"op":"update_event","eventId":'"$E1"',"description":"晒谷场开会，乙复核：到会约两百人"}
]}' >/dev/null
post "$BASE/api/editor/sessions/$SG/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error(JSON.stringify(d));process.exit(1)}
console.log(`重开会话提交成功：新草稿修订号 ${d.revisionNo}`);'

say "9) 会话内容仅持口令可见；访客年表不含任何会话信息"
code=$(http_code "$BASE/api/editor/sessions/$SG")
[ "$code" = 401 ] && echo "OK：访客读会话详情 → 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("访客年表响应不含 sessions 字段：", !("sessions" in d) ? "OK" : "FAIL");
if("sessions" in d) process.exit(1);'

say "全部断言通过 ✅"
echo "提示：$BASE/editor 的「并行编辑会话」卡片可图形化开启会话、暂存操作、提交并查看冲突明细。"
