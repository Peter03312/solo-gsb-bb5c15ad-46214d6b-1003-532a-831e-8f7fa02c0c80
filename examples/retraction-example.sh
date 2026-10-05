#!/usr/bin/env bash
# 版本撤回（按版本号撤回整版公开展示）端到端调用示例。
#
# 流程：建草稿 → 连续发布两版 → 建一条引用第二版的专题路线
#       → 撤回第二版（非空原因）→ 核对访客视图（最新年表回退、清单隐藏、路线 404）
#       → 核对编辑者视图（原文、原因、路线仍可见）
#       → 重复撤回幂等 → 以撤回版为基准的预约到期转冲突
#       → 修正后重新发布（编号继续递增，访客立即可读）。
#
# 依赖：curl 与 node（本应用本身就需要 node，用于解析 JSON）。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/retraction-example.sh
# 可重复运行（标题带时间戳，避免与历史数据互相干扰；版本号按当前最新递增）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
# 从标准输入的 JSON 中取字段：echo "$json" | jfield 'd.event.id'
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
latest_no() { get_ed "$BASE/api/editor/versions" | jfield 'd.currentVersionNo'; }

say "0) 口令检查（错误口令应 401）"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" \
  -H 'X-Editor-Token: wrong-token' -d '{"reason":"x"}' "$BASE/api/editor/versions/1/retract")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 建草稿：2 个事件 + 各 1 条主张 + 一条先于关系"
E1=$(post "$BASE/api/editor/events" -d '{"title":"示例动员会 '$TS'"}' | jfield 'd.event.id')
E2=$(post "$BASE/api/editor/events" -d '{"title":"示例通水会 '$TS'"}' | jfield 'd.event.id')
C1=$(post "$BASE/api/editor/events/$E1/claims" \
  -d '{"precision":"day","year":1958,"month":9,"day":12,"source":"李宝山口述 '$TS'"}' | jfield 'd.claim.id')
C2=$(post "$BASE/api/editor/events/$E2/claims" \
  -d '{"precision":"month","year":1959,"month":5,"source":"王秀兰口述 '$TS'"}' | jfield 'd.claim.id')
post "$BASE/api/editor/relations" \
  -d '{"earlierId":'"$E1"',"laterId":'"$E2"',"source":"二人口述一致 '$TS'"}' >/dev/null
SEL='[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'}]'
echo "事件 $E1、$E2；主张 $C1、$C2"

say "2) 连续发布两版（第二版假定随后发现编年依据错误）"
V1=$(post "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL"',"baseVersionNo":'"$(latest_no)"',"note":"撤回示例首版","editor":"示例脚本"}' \
  | jfield 'd.versionNo')
V2=$(post "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL"',"baseVersionNo":'"$V1"',"note":"撤回示例二版","editor":"示例脚本"}' \
  | jfield 'd.versionNo')
echo "已发布：第 $V1 版、第 $V2 版"

say "3) 建一条引用第 $V2 版的专题路线（撤回后该路线对访客隐藏）"
ROUTE=$(post "$BASE/api/editor/routes" \
  -d '{"title":"示例脉络 '$TS'","versionNo":'"$V2"',"anchorEventIds":['"$E1"','"$E2"'],"editor":"示例脚本"}' \
  | jfield 'd.route.routeNo')
echo "路线 #$ROUTE（据第 $V2 版）"

say "4) 非法请求：版本不存在 404；空原因 400；均不改状态"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" \
  "$BASE/api/editor/versions/999999/retract" -d '{"reason":"x"}')
[ "$code" = 404 ] && echo "OK：版本不存在返回 404" || { echo "FAIL：期望 404，实际 $code"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" \
  "$BASE/api/editor/versions/$V2/retract" -d '{"reason":"   "}')
[ "$code" = 400 ] && echo "OK：空原因返回 400" || { echo "FAIL：期望 400，实际 $code"; exit 1; }
get_ed "$BASE/api/editor/retractions" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.retractions.length !== 0) { console.error("FAIL：非法请求却落库了"); process.exit(1); }
console.log("OK：撤回清单仍为空（状态未变）");'

say "5) 撤回第 $V2 版（非空原因；只追加审计记录，快照与版本号不变）"
post "$BASE/api/editor/versions/$V2/retract" \
  -d '{"reason":"动员会日期考证有误，需撤回修订（示例 '$TS'）","editor":"示例脚本"}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("alreadyRetracted =", d.alreadyRetracted);
console.log("撤回记录 =", JSON.stringify(d.retraction));
console.log("发布基准 currentVersionNo =", d.currentVersionNo, " 访客可见 latestVisibleVersionNo =", d.latestVisibleVersionNo);'

say "6) 访客视图：最新年表回退到第 $V1 版；版本清单与指定版读取隐藏撤回版；路线 404"
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("访客最新年表 = 第", d.currentVersionNo, "版（事件数", d.version.eventCount, "）");'
curl -s "$BASE/api/public/versions" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("访客版本清单 =", d.versions.map(v=>v.versionNo).join(", "), " currentVersionNo =", d.currentVersionNo);'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/public/versions/$V2")
[ "$code" = 404 ] && echo "OK：访客读撤回版返回 404（按不存在处理）" || { echo "FAIL：期望 404，实际 $code"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/public/routes/$ROUTE")
[ "$code" = 404 ] && echo "OK：引用撤回版的路线对访客 404" || { echo "FAIL：期望 404，实际 $code"; exit 1; }
curl -s "$BASE/api/public/routes" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("访客路线清单条数 =", d.routes.length);'

say "7) 编辑者视图：撤回版原文、原因与相关路线仍可见"
get_ed "$BASE/api/editor/versions/$V2/raw" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("原文出处 =", d.version.events.map(e=>e.source).join(" / "));
console.log("撤回原因 =", d.retraction.reason, " 撤回时间 =", d.retraction.retractedAt, "UTC");'
get_ed "$BASE/api/editor/routes/$ROUTE/raw" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("路线 #'"$ROUTE"' 编辑者可见：", d.route.title, " versionRetracted =", d.versionRetracted);'

say "8) 重复撤回幂等：返回首次记录，不覆盖原因"
post "$BASE/api/editor/versions/$V2/retract" -d '{"reason":"试图改写的另一条原因","editor":"另一个人"}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.alreadyRetracted !== true) { console.error("FAIL：应为幂等返回"); process.exit(1); }
console.log("OK：alreadyRetracted =", d.alreadyRetracted, " 原因仍为 =", d.retraction.reason);'

say "9) 以撤回版为冻结基准的待执行预约：到期转冲突，不生成新版本"
AT=$(node -e 'console.log(new Date(Date.now()+3000).toISOString().replace(/\.\d{3}Z$/,"Z"))')
# 注意：预约基准是「最高已发布版本号」（含撤回版），即第 V2 版
SNO=$(post "$BASE/api/editor/schedules" \
  -d '{"selection":'"$SEL"',"scheduledAt":"'"$AT"'","baseVersionNo":'"$V2"',"editor":"示例脚本","note":"基准为撤回版的预约"}' \
  | jfield 'd.schedule.scheduleNo')
echo "预约 #$SNO 将于 $AT 到期（冻结基准 = 第 $V2 版，已撤回）"
sleep 4
get_ed "$BASE/api/editor/schedules/$SNO" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const s=d.schedule;
if (s.status !== "conflict") { console.error("FAIL：应转冲突，实际", s.status); process.exit(1); }
console.log("OK：status =", s.status, " resultVersionNo =", s.resultVersionNo);
console.log("    resultMessage =", s.resultMessage.slice(0, 60) + "…");'
[ "$(latest_no)" = "$V2" ] && echo "OK：未生成新版本（最高版本号仍为 $V2）" || { echo "FAIL：版本号被推进"; exit 1; }

say "10) 修正后重新发布：仍以最高已发布版本号（第 $V2 版）为基准，编号递增"
NEWV=$(post "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL"',"baseVersionNo":'"$V2"',"note":"修正编年后的新版 '$TS'","editor":"示例脚本"}' \
  | jfield 'd.versionNo')
[ "$NEWV" = "$((V2+1))" ] && echo "OK：新版本号 $NEWV 继续递增" || { echo "FAIL：期望 $((V2+1))，实际 $NEWV"; exit 1; }
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("访客最新年表 = 第", d.currentVersionNo, "版（修正版立即可读）");'

say "11) 全部撤回时：访客看到「尚无可读版本」"
post "$BASE/api/editor/versions/$V1/retract" -d '{"reason":"首版同样有误（示例）","editor":"示例脚本"}' >/dev/null
post "$BASE/api/editor/versions/$NEWV/retract" -d '{"reason":"演示全部撤回（示例）","editor":"示例脚本"}' >/dev/null
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.published !== false || d.allRetracted !== true) { console.error("FAIL：应为尚无可读版本"); process.exit(1); }
console.log("OK：published =", d.published, " allRetracted =", d.allRetracted, " message =", d.message);'
# 演示收尾：再发布一版，访客恢复可读
FINALV=$(post "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL"',"baseVersionNo":'"$(latest_no)"',"note":"收尾恢复可读 '$TS'","editor":"示例脚本"}' \
  | jfield 'd.versionNo')
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("再发布后访客最新年表 = 第", d.currentVersionNo, "版");'

say "全部断言通过 ✅"
echo "提示：可打开 $BASE/ 查看访客年表，$BASE/editor 在「已发布版本」中查看撤回标记与原因。"
