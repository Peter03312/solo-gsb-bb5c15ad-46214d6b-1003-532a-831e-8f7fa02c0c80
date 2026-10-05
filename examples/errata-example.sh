#!/usr/bin/env bash
# 勘误附记（对指定已发布版本中的事件 / 「先于」关系登记附记）端到端调用示例。
#
# 流程：建草稿 → 发布两版 → 对第 1 版的事件与「先于」关系登记附记
#       → 访客读取目标版 / 最新年表可见生效附记（新版不继承）
#       → 替代附记（须提交所见附记号；两人同时替代仅一个成功，冲突方取得当前附记且不落库）
#       → 附记出处按精确文本遮盖 → 撤回目标版后访客不可见、编辑者查原文与替代链。
#
# 依赖：curl 与 node（本应用本身就需要 node，用于解析 JSON）。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/errata-example.sh
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
  -H 'X-Editor-Token: wrong-token' -d '{"versionNo":1,"targetType":"event","targetId":1,"note":"x","source":"y"}' \
  "$BASE/api/editor/errata")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 建草稿：2 个事件 + 各 1 条主张 + 一条先于关系"
E1=$(post "$BASE/api/editor/events" -d '{"title":"示例动员会 '$TS'"}' | jfield 'd.event.id')
E2=$(post "$BASE/api/editor/events" -d '{"title":"示例通水会 '$TS'"}' | jfield 'd.event.id')
C1=$(post "$BASE/api/editor/events/$E1/claims" \
  -d '{"precision":"day","year":1958,"month":9,"day":12,"source":"李宝山口述 '$TS'"}' | jfield 'd.claim.id')
C2=$(post "$BASE/api/editor/events/$E2/claims" \
  -d '{"precision":"month","year":1959,"month":5,"source":"王秀兰口述 '$TS'"}' | jfield 'd.claim.id')
R1=$(post "$BASE/api/editor/relations" \
  -d '{"earlierId":'"$E1"',"laterId":'"$E2"',"source":"二人口述一致 '$TS'"}' | jfield 'd.relation.id')
SEL='[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'}]'
echo "事件 $E1、$E2；主张 $C1、$C2；关系 $R1"

say "2) 连续发布两版（附记只登记到第 1 版，验证第 2 版不继承）"
V1=$(post "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL"',"baseVersionNo":'"$(latest_no)"',"note":"勘误示例首版","editor":"示例脚本"}' \
  | jfield 'd.versionNo')
V2=$(post "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL"',"baseVersionNo":'"$V1"',"note":"勘误示例二版","editor":"示例脚本"}' \
  | jfield 'd.versionNo')
echo "已发布：第 $V1 版、第 $V2 版"

say "3) 非法请求：版本不存在 404；对象不属该版 422；说明为空 400；均不落库"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/errata" \
  -d '{"versionNo":999999,"targetType":"event","targetId":'"$E1"',"note":"x","source":"y"}')
[ "$code" = 404 ] && echo "OK：版本不存在返回 404" || { echo "FAIL：期望 404，实际 $code"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/errata" \
  -d '{"versionNo":'"$V1"',"targetType":"relation","targetId":999999,"note":"x","source":"y"}')
[ "$code" = 422 ] && echo "OK：对象不属该版返回 422" || { echo "FAIL：期望 422，实际 $code"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/errata" \
  -d '{"versionNo":'"$V1"',"targetType":"event","targetId":'"$E1"',"note":"   ","source":"y"}')
[ "$code" = 400 ] && echo "OK：空说明返回 400" || { echo "FAIL：期望 400，实际 $code"; exit 1; }
get_ed "$BASE/api/editor/versions/$V1/errata" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.totalCount !== 0) { console.error("FAIL：非法请求却落库了"); process.exit(1); }
console.log("OK：第 '"$V1"' 版附记仍为 0 条（状态未变）");'

say "4) 对第 $V1 版的事件与「先于」关系登记附记（说明 + 出处）"
N1=$(post "$BASE/api/editor/errata" \
  -d '{"versionNo":'"$V1"',"targetType":"event","targetId":'"$E1"',
       "note":"动员会日期应为 1958-09-13，口述记忆有误（示例 '"$TS"'）",
       "source":"《县水利志》1994 年版，第 87 页","editor":"示例脚本"}' | jfield 'd.errata.errataId')
N2=$(post "$BASE/api/editor/errata" \
  -d '{"versionNo":'"$V1"',"targetType":"relation","targetId":'"$R1"',
       "note":"该先后关系另有反证待核（示例 '"$TS"'）","source":"张德福口述，2022-03-11 访谈","editor":"示例脚本"}' \
  | jfield 'd.errata.errataId')
echo "已登记：附记 #$N1（事件 $E1）、附记 #$N2（关系 $R1）"

say "5) 访客读取目标版与最新年表可见生效附记；第 $V2 版不继承"
curl -s "$BASE/api/public/versions/$V1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("第 '"$V1"' 版附记 =", d.version.errata.map(x=>"#"+x.errataId+"("+x.targetType+"→"+(x.target.title||(x.target.earlierTitle+" 先于 "+x.target.laterTitle))+") "+x.note.slice(0,18)+"…").join("；"));'
curl -s "$BASE/api/public/versions/$V2" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.version.errata.length !== 0) { console.error("FAIL：新版不应继承附记"); process.exit(1); }
console.log("OK：第 '"$V2"' 版附记 = 0 条（附记只属于目标版）");'
# 最新年表即第 V2 版，故也不含第 V1 版附记
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("访客最新年表 = 第", d.currentVersionNo, "版，附记", d.version.errata.length, "条");'

say "6) 替代附记：须提交所见附记号；两人同时替代仅一个成功"
# 未提交所见附记号 → 409 并取得当前生效附记，不落库
post "$BASE/api/editor/errata" \
  -d '{"versionNo":'"$V1"',"targetType":"event","targetId":'"$E1"',"note":"想悄悄替代","source":"某档案"}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.code !== "ERRATA_CONFLICT") { console.error("FAIL：应为 ERRATA_CONFLICT"); process.exit(1); }
console.log("OK：未提交所见附记号 → 409，当前生效附记 = #" + d.current.errataId);'
# 甲、乙都基于附记 #N1 提交替代：先提交者成功，后提交者 409 取得当前附记且不落库
N3=$(post "$BASE/api/editor/errata" \
  -d '{"versionNo":'"$V1"',"targetType":"event","targetId":'"$E1"',
       "note":"更正：应为 1958-09-14（甲）","source":"某档案，第 12 页","editor":"甲","replacesErrataId":'"$N1"'}' \
  | jfield 'd.errata.errataId')
post "$BASE/api/editor/errata" \
  -d '{"versionNo":'"$V1"',"targetType":"event","targetId":'"$E1"',
       "note":"更正：应为 1958-09-15（乙）","source":"另一档案","editor":"乙","replacesErrataId":'"$N1"'}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.code !== "ERRATA_CONFLICT") { console.error("FAIL：同时替代应只有一人成功"); process.exit(1); }
console.log("OK：乙的替代被拒（未落库），取得当前生效附记 #" + d.current.errataId + "：「" + d.current.note + "」");'
echo "甲的替代成功：附记 #$N3 替代 #$N1"

say "7) 同一目标只展示最新生效附记；编辑者可查原文与完整替代链"
curl -s "$BASE/api/public/versions/$V1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const ev=d.version.errata.filter(x=>x.targetType==="event");
if (ev.length !== 1) { console.error("FAIL：同一目标应只展示最新生效附记"); process.exit(1); }
console.log("OK：事件目标生效附记 = #" + ev[0].errataId + "「" + ev[0].note + "」");'
get_ed "$BASE/api/editor/errata/$N1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("替代链（旧→新）=", d.chain.map(c=>"#"+c.errataId+"「"+c.note.slice(0,16)+"…」").join(" → "));
console.log("当前生效 = #" + d.effective.errataId, "；旧附记 #" + d.errata.errataId + " 原文保留：「" + d.errata.note.slice(0,20) + "…」");'

say "8) 附记出处沿用精确文本遮盖规则（访客「出处已遮盖」，编辑者查原文）"
PRE=$(post "$BASE/api/editor/redaction-preview" -d '{"source":"张德福口述，2022-03-11 访谈"}')
CV=$(echo "$PRE" | jfield 'd.currentVersionNo')
post "$BASE/api/editor/redaction" \
  -d '{"source":"张德福口述，2022-03-11 访谈","currentVersionNo":'"$CV"',"editor":"示例脚本"}' >/dev/null
curl -s "$BASE/api/public/versions/$V1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const rel=d.version.errata.find(x=>x.targetType==="relation");
if (rel.source !== "出处已遮盖") { console.error("FAIL：附记出处应被遮盖，实际", rel.source); process.exit(1); }
console.log("OK：访客看到的关系附记出处 =", rel.source, "（说明原文 =", rel.note.slice(0,16) + "…）");'
get_ed "$BASE/api/editor/versions/$V1/errata" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const rel=d.targets.find(t=>t.targetType==="relation");
console.log("OK：编辑者查原文 =", rel.effective.source);'

say "9) 撤回目标版：拒绝再登记（409）；访客不再看到该版及其附记；编辑者仍可查"
post "$BASE/api/editor/versions/$V1/retract" \
  -d '{"reason":"首版编年依据有误（勘误示例 '"$TS"'）","editor":"示例脚本"}' >/dev/null
post "$BASE/api/editor/errata" \
  -d '{"versionNo":'"$V1"',"targetType":"event","targetId":'"$E1"',"note":"撤回后再登记","source":"某档案","replacesErrataId":'"$N3"'}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.code !== "VERSION_RETRACTED") { console.error("FAIL：撤回版应拒绝登记"); process.exit(1); }
console.log("OK：撤回版登记被拒 =", d.code);'
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/public/versions/$V1")
[ "$code" = 404 ] && echo "OK：访客读撤回版 404（附记随之不可见）" || { echo "FAIL：期望 404，实际 $code"; exit 1; }
get_ed "$BASE/api/editor/versions/$V1/errata" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("OK：编辑者仍可查撤回版附记", d.totalCount, "条（含替代链），撤回原因 =", d.retraction.reason.slice(0,20) + "…");'

say "全部断言通过 ✅"
echo "提示：可打开 $BASE/ 查看访客年表，$BASE/editor 「勘误附记」卡片登记与查阅附记。"
