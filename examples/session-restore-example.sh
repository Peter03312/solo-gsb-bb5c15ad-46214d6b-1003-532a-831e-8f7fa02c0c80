#!/usr/bin/env bash
# 并行编辑会话 × 从历史版本恢复草稿（对象身份更替）端到端调用示例。
#
# 场景：
#   1) 甲建好事件 A 并开启编辑会话，暂存「改 A 的描述」
#   2) 乙删除 A、创建事件 B 并发布第 1 版，再从该版恢复草稿——恢复重排编号，B 占用编号 1
#   3) 甲的会话详情提示 restoredAfterOpen；提交被整次拒绝（409 restore_rebased），
#      B 的描述不会被写入；重复提交保持首次冲突结果（alreadyConflicted）
#   4) 甲基于最新草稿重开会话，重新暂存后提交成功
#
# 依赖：curl 与 node。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/session-restore-example.sh
# 总耗时约 3 秒。可重复运行（标题带时间戳）。
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

say "1) 甲建好事件 A（编号 1），开启编辑会话并暂存「改 A 的描述」"
A=$(post "$BASE/api/editor/events" -d '{"title":"事件A（将被恢复替换）'$TS'"}' | jfield 'd.event.id')
[ "$A" = 1 ] || echo "提示：事件 A 编号为 $A（草稿区非空；示例照常进行，恢复后新对象占用编号 1 的演示以全新库最直观）"
SID=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲"}' | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.error(`甲的会话 #${d.session.sessionId}：基线修订号 ${d.session.baseRevisionNo}，恢复序号 ${d.session.baseRestoreNo}`);
process.stdout.write(String(d.session.sessionId));')
post "$BASE/api/editor/sessions/$SID/ops" -d '{"ops":[
  {"op":"update_event","eventId":'"$A"',"description":"甲改的描述（不应写进恢复后的同编号对象）"}
]}' | jfield 'd.staged' >/dev/null
echo "已暂存 1 条操作（改事件 $A 的描述）"

say "2) 乙删除 A、创建事件 B 并发布第 1 版，再从该版恢复草稿（B 重新占用编号 $A）"
curl -s -X DELETE "${h_ed[@]}" "$BASE/api/editor/events/$A" >/dev/null
B=$(post "$BASE/api/editor/events" -d '{"title":"事件B（恢复后占用编号）'$TS'"}' | jfield 'd.event.id')
CB=$(post "$BASE/api/editor/events/$B/claims" \
  -d '{"precision":"year","year":1958,"source":"乙的出处 '$TS'"}' | jfield 'd.claim.id')
post "$BASE/api/editor/publish" \
  -d '{"selection":[{"eventId":'"$B"',"claimId":'"$CB"'}],"baseVersionNo":0,"editor":"乙"}' \
  | jfield 'd.versionNo' | xargs -I{} echo "已发布第 {} 版（事件B）"
PV=$(get_ed "$BASE/api/editor/restore-preview/1")
post "$BASE/api/editor/restore" \
  -d '{"versionNo":1,"draftRevisionNo":'"$(echo "$PV" | jfield 'd.draftRevisionNo')"',"currentVersionNo":'"$(echo "$PV" | jfield 'd.currentVersionNo')"'}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error(JSON.stringify(d));process.exit(1)}
console.log(`已恢复：旧事件#${d.idMap.events[0].oldEventId} → 新草稿事件#${d.idMap.events[0].newEventId}（编号重新占用），新草稿修订号 ${d.revisionNo}`);'

say "3) 甲的会话跨恢复：详情提示对象身份更替；提交整次拒绝（409 restore_rebased），草稿不改动"
get_ed "$BASE/api/editor/sessions/$SID" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log(`会话状态 ${d.session.status}，restoredAfterOpen = ${d.session.restoredAfterOpen}`);
if(d.session.restoredAfterOpen!==true) process.exit(1);'
REV_BEFORE=$(get_ed "$BASE/api/editor/state" | jfield 'd.draftRevisionNo')
code=$(http_code -X POST "${h_ed[@]}" "$BASE/api/editor/sessions/$SID/commit")
[ "$code" = 409 ] && echo "OK：跨恢复提交 → 409 SESSION_MERGE_CONFLICT" || { echo "FAIL：期望 409，实际 $code"; exit 1; }
post "$BASE/api/editor/sessions/$SID/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const c=d.conflicts[0];
console.log(`冲突类型：${c.type}（重复提交同样 409 且 alreadyConflicted=${d.alreadyConflicted}）`);
console.log(`原因：${c.message}`);
for(const r of c.restores) console.log(`  恢复明细：第 ${r.restoreNo} 次，恢复自第 ${r.versionNo} 版（${r.restoredAt} UTC）`);
if(d.code!=="SESSION_MERGE_CONFLICT"||c.type!=="restore_rebased"||d.alreadyConflicted!==true) process.exit(1);'
get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const e=d.events.find(x=>x.title.includes("事件B"));
console.log(`草稿未动：事件B（编号 ${e.id}）描述仍为「${e.description}」（甲的暂存改动没有写进来），修订号 ${d.draftRevisionNo}`);
if(e.description!=="") process.exit(1);'
REV_AFTER=$(get_ed "$BASE/api/editor/state" | jfield 'd.draftRevisionNo')
[ "$REV_AFTER" = "$REV_BEFORE" ] && echo "OK：修订号未推进（$REV_BEFORE），整次未改草稿" || { echo "FAIL：修订号 $REV_BEFORE → $REV_AFTER"; exit 1; }

say "4) 甲基于最新草稿重开会话：基线即恢复后的草稿，重新暂存后提交成功"
SID2=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲"}' | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.error(`甲重开会话 #${d.session.sessionId}：基线恢复序号 ${d.session.baseRestoreNo}，restoredAfterOpen=${d.session.restoredAfterOpen}，基线事件「${d.session.baseline.events[0].title}」（编号 ${d.session.baseline.events[0].id}）`);
process.stdout.write(String(d.session.sessionId));')
NEWID=$(get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
process.stdout.write(String(d.events.find(x=>x.title.includes("事件B")).id))')
post "$BASE/api/editor/sessions/$SID2/ops" -d '{"ops":[
  {"op":"update_event","eventId":'"$NEWID"',"description":"甲改的描述（重开会话后落在事件B上）"}
]}' >/dev/null
post "$BASE/api/editor/sessions/$SID2/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error(JSON.stringify(d));process.exit(1)}
console.log(`重开会话提交成功：新草稿修订号 ${d.revisionNo}`);'
get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const e=d.events.find(x=>x.title.includes("事件B"));
console.log(`草稿现状：事件B 描述=「${e.description}」`);
if(!e.description.includes("甲改的描述")) process.exit(1);'

say "全部断言通过 ✅"
echo "提示：恢复后的编号映射（idMap）、已发布快照与既有接口契约均未改变；普通并行编辑仍按三方合并规则处理。"
