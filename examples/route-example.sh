#!/usr/bin/env bash
# 专题「先于」脉络路线（thematic routes）端到端调用示例。
#
# 流程：建草稿（5 个事件，A→D 之间有两条等长路径）→ 发布第 1 版
#       → 建立三锚点路线（验证：中间事件、最少关系数、同长度按关系 ID 序列择小）
#       → 访客视图（按遮盖规则显示）与编辑口令原文视图对比
#       → 遮盖一处出处后核对访客路线视图
#       → 改草稿并发布第 2 版，验证旧路线不变
#       → 各类错误：重复事件 400、未知版本 404、未知事件 422、断点 422（整条不保存）
#
# 依赖：curl 与 node（本应用本身就需要 node，用于解析 JSON）。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/route-example.sh
# 可重复运行（标题与出处带时间戳，避免与历史数据互相干扰）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
# 从标准输入的 JSON 中取字段：echo "$json" | jfield 'd.route.routeNo'
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
# 断言 JSON 字段等于期望值：jeq 'JSON字符串' 'd.a.b' '期望'
jeq() { node -e 'const d=JSON.parse(process.argv[1]); const got=JSON.stringify(eval(process.argv[2])); const want=JSON.stringify(JSON.parse(process.argv[3])); if(got!==want){console.error(`断言失败：${process.argv[2]} = ${got}，期望 ${want}`);process.exit(1)}' "$1" "$2" "$3"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
get_pub() { curl -s "$@"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

say "0) 口令检查（错误口令应 401）"
code=$(http_code -X POST "${h_json[@]}" -H 'X-Editor-Token: wrong' \
  -d '{"title":"x","versionNo":1,"anchorEventIds":[1,2]}' "$BASE/api/editor/routes")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 建草稿：5 个事件 + 主张 + 关系（A→D 有两条等长路径）"
# 关系图：A→B, A→C, C→D, B→D, D→E（按此顺序建，关系 id 依次递增）
# A→D 的两条最短路径：A→B→D（关系 [R1,R4]）与 A→C→D（关系 [R2,R3]），
# 长度同为 2，按关系 ID 序列字典序应选 [R1,R4]（R1<R2）。
mk_event() { post "$BASE/api/editor/events" -d '{"title":"'"$1"'"}' | jfield 'd.event.id'; }
mk_claim() { post "$BASE/api/editor/events/$1/claims" -d "$2" | jfield 'd.claim.id'; }
A=$(mk_event "路线示例·动员会 $TS")
B=$(mk_event "路线示例·丈量土地 $TS")
C=$(mk_event "路线示例·物资调配 $TS")
D=$(mk_event "路线示例·渠道合龙 $TS")
E=$(mk_event "路线示例·通水 $TS")
CA=$(mk_claim "$A" '{"precision":"day","year":1958,"month":9,"day":12,"source":"李宝山口述 '"$TS"'"}')
CB=$(mk_claim "$B" '{"precision":"month","year":1958,"month":11,"source":"档案全宗12 '"$TS"'"}')
CC=$(mk_claim "$C" '{"precision":"month","year":1958,"month":12,"source":"王秀兰口述 '"$TS"'"}')
CD=$(mk_claim "$D" '{"precision":"month","year":1959,"month":3,"source":"县志水利篇 '"$TS"'"}')
CE=$(mk_claim "$E" '{"precision":"month","year":1959,"month":5,"source":"张德福口述 '"$TS"'"}')
R1=$(post "$BASE/api/editor/relations" -d '{"earlierId":'"$A"',"laterId":'"$B"',"source":"二人口述一致 '"$TS"'"}' | jfield 'd.relation.id')
R2=$(post "$BASE/api/editor/relations" -d '{"earlierId":'"$A"',"laterId":'"$C"',"source":"旁证 '"$TS"'"}' | jfield 'd.relation.id')
R3=$(post "$BASE/api/editor/relations" -d '{"earlierId":'"$C"',"laterId":'"$D"',"source":"县志 '"$TS"'"}' | jfield 'd.relation.id')
R4=$(post "$BASE/api/editor/relations" -d '{"earlierId":'"$B"',"laterId":'"$D"',"source":"档案 '"$TS"'"}' | jfield 'd.relation.id')
R5=$(post "$BASE/api/editor/relations" -d '{"earlierId":'"$D"',"laterId":'"$E"',"source":"张德福口述 '"$TS"'"}' | jfield 'd.relation.id')
V0=$(get_pub "$BASE/api/public/versions" | jfield 'd.currentVersionNo')
post "$BASE/api/editor/publish" -d '{"selection":[
  {"eventId":'"$A"',"claimId":'"$CA"'},{"eventId":'"$B"',"claimId":'"$CB"'},
  {"eventId":'"$C"',"claimId":'"$CC"'},{"eventId":'"$D"',"claimId":'"$CD"'},
  {"eventId":'"$E"',"claimId":'"$CE"'}],"baseVersionNo":'"$V0"',"editor":"示例脚本","note":"路线示例首版"}' >/dev/null
V1=$(get_pub "$BASE/api/public/versions" | jfield 'd.currentVersionNo')
echo "已发布第 $V1 版（事件 A=$A B=$B C=$C D=$D E=$E；关系 R1..R5=$R1,$R2,$R3,$R4,$R5）"

say "2) 建立三锚点路线 A → D → E（标题 + 版本 + 锚点顺序）"
ROUTE=$(post "$BASE/api/editor/routes" -d '{
  "title":"东干渠建设脉络 '"$TS"'",
  "versionNo":'"$V1"',
  "anchorEventIds":['"$A"','"$D"','"$E"'],
  "editor":"示例脚本","note":"演示路线"}')
echo "$ROUTE" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify(d.route,null,2))' | head -40
ROUTE_NO=$(echo "$ROUTE" | jfield 'd.route.routeNo')
# 第 1 段 A→D：等长路径中按关系 ID 序列择小 → A→B→D（关系 [R1,R4]），B 为中间事件
jeq "$ROUTE" "d.route.segments[0].eventIds" "[$A,$B,$D]" && echo "OK：第 1 段见证链 = A→B→D（关系数最少且 ID 序列最小）"
jeq "$ROUTE" "d.route.segments[0].relationIds" "[$R1,$R4]" && echo "OK：第 1 段关系序列 = [$R1,$R4]"
jeq "$ROUTE" "d.route.segments[1].eventIds" "[$D,$E]" && echo "OK：第 2 段直达 D→E"
ROLES=$(echo "$ROUTE" | jfield 'JSON.stringify(d.route.events.map(e=>e.role))')
echo "链上角色：$ROLES（锚点 anchor / 中间事件 intermediate）"
# 路线只涉及 A,B,D,E 与关系 R1,R4,R5：C、R2、R3 不出现
echo "$ROUTE" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
  const evs=d.route.events.map(e=>e.eventId), rels=d.route.relations.map(r=>r.relationId);
  if(evs.includes(Number(process.argv[1]))){console.error("FAIL：未涉及的事件 C 出现在路线中");process.exit(1)}
  if(rels.includes(Number(process.argv[2]))||rels.includes(Number(process.argv[3]))){console.error("FAIL：未涉及的关系出现在路线中");process.exit(1)}
  console.log("OK：路线只展示涉及的事件与关系（事件 C 与关系 R2/R3 不在其中）")' "$C" "$R2" "$R3"

say "3) 访客公开视图（无需口令）与编辑者原文视图"
get_pub "$BASE/api/public/routes/$ROUTE_NO" | jfield 'd.route.title' >/dev/null && echo "OK：访客可读取路线详情"
PUB_SRC=$(get_pub "$BASE/api/public/routes/$ROUTE_NO" | jfield 'd.route.events.find(e=>e.role==="anchor").source')
echo "访客看到的锚点出处：$PUB_SRC"
echo "编辑者原文视图：GET /api/editor/routes/$ROUTE_NO/raw（持口令）"
get_ed "$BASE/api/editor/routes/$ROUTE_NO/raw" | jfield 'd.route.routeNo' >/dev/null && echo "OK：持口令可查看原文"

say "4) 遮盖一处出处后，访客路线视图自动显示「出处已遮盖」"
SRC="李宝山口述 $TS"
PREV=$(post "$BASE/api/editor/redaction-preview" -d '{"source":"'"$SRC"'"}')
CUR=$(echo "$PREV" | jfield 'd.currentVersionNo')
post "$BASE/api/editor/redaction" -d '{"source":"'"$SRC"'","currentVersionNo":'"$CUR"',"editor":"示例脚本"}' >/dev/null
MASKED=$(get_pub "$BASE/api/public/routes/$ROUTE_NO" | jfield 'd.route.events.find(e=>e.eventId==='"$A"').source')
[ "$MASKED" = "出处已遮盖" ] && echo "OK：访客路线视图中命中出处显示「出处已遮盖」" || { echo "FAIL：期望「出处已遮盖」，实际 $MASKED"; exit 1; }
RAW_SRC=$(get_ed "$BASE/api/editor/routes/$ROUTE_NO/raw" | jfield 'd.route.events.find(e=>e.eventId==='"$A"').source')
[ "$RAW_SRC" = "$SRC" ] && echo "OK：编辑者持口令仍见原文" || { echo "FAIL：原文视图被改动"; exit 1; }

say "5) 改草稿并发布第 2 版：旧路线不变（固定所据版本、锚点顺序与见证链）"
BEFORE=$(get_pub "$BASE/api/public/routes/$ROUTE_NO")
curl -s -X DELETE "${h_ed[@]}" "$BASE/api/editor/relations/$R1" >/dev/null   # 草稿删掉 R1
curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/events/$A" -d '{"title":"动员会（草稿改名）","description":""}' >/dev/null
post "$BASE/api/editor/publish" -d '{"selection":[
  {"eventId":'"$A"',"claimId":'"$CA"'},{"eventId":'"$B"',"claimId":'"$CB"'},
  {"eventId":'"$C"',"claimId":'"$CC"'},{"eventId":'"$D"',"claimId":'"$CD"'},
  {"eventId":'"$E"',"claimId":'"$CE"'}],"baseVersionNo":'"$V1"',"editor":"示例脚本","note":"第二版"}' >/dev/null
AFTER=$(get_pub "$BASE/api/public/routes/$ROUTE_NO")
[ "$BEFORE" = "$AFTER" ] && echo "OK：删除草稿关系、改标题、发布新版后，路线内容逐字节不变" || { echo "FAIL：路线被后续修改影响"; exit 1; }

say "6) 错误情形（均不保存）"
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/routes" \
  -d '{"title":"x","versionNo":'"$V1"',"anchorEventIds":['"$A"','"$D"','"$A"']}')
[ "$code" = 400 ] && echo "OK：重复事件 → 400" || { echo "FAIL：重复事件期望 400，实际 $code"; exit 1; }
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/routes" \
  -d '{"title":"x","versionNo":99999,"anchorEventIds":['"$A"','"$D"']}')
[ "$code" = 404 ] && echo "OK：未知版本 → 404" || { echo "FAIL：未知版本期望 404，实际 $code"; exit 1; }
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/routes" \
  -d '{"title":"x","versionNo":'"$V1"',"anchorEventIds":['"$A"',987654]}')
[ "$code" = 422 ] && echo "OK：未知事件 → 422" || { echo "FAIL：未知事件期望 422，实际 $code"; exit 1; }
# 断点：E→A 方向无有向路径，整条拒绝并指出断点
RESP=$(post "$BASE/api/editor/routes" -d '{"title":"x","versionNo":'"$V1"',"anchorEventIds":['"$E"','"$A"']}')
echo "$RESP" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
  if(d.status!==422||!d.errors||d.errors[0].type!=="disconnected"){console.error("FAIL：断点应返回 422 disconnected",JSON.stringify(d));process.exit(1)}
  console.log("OK：无法连通 → 422，断点信息："+d.errors[0].message)'
CNT=$(get_ed "$BASE/api/editor/routes" | jfield 'd.routes.length')
[ "$CNT" = "1" ] && echo "OK：上述失败均未保存，仍只有 1 条路线" || { echo "FAIL：失败请求留下了路线（$CNT 条）"; exit 1; }

say "全部通过。路线 #$ROUTE_NO 可在访客页查看：$BASE/ （API：$BASE/api/public/routes/$ROUTE_NO）"
