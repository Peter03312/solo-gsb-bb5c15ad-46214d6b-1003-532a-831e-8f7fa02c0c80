# 地方口述史事件年表（Oral Chronicle）

供地方口述史团队本机使用的事件年表 Web 应用。编辑者录入**事件**、带**出处**的时间主张（可精确到年 / 月 / 日），以及事件之间的**「先于」关系**；同一事件可以保留多条互相矛盾的主张。发布时为每个事件选定一条主张，系统检查全部先后关系后生成**不可变版本**。访客只能看到最新未撤回的已发布年表。

- 技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 浏览器原生界面（无需前端构建）

## 一键启动（Docker Compose，推荐）

```bash
docker compose up -d --build
```

启动即完成：安装依赖、初始化 SQLite 数据库（自动建表）、挂载持久化数据卷。
Compose 默认 `SEED_DEMO=1`，首次启动会写入一组演示草稿（3 个事件，含矛盾主张），方便体验发布流程。

访问地址：

| 用途 | 地址 |
| --- --- | --- |
| 访客年表（只读最新已发布版本） | http://localhost:3000/ |
| 编辑者工作台 | http://localhost:3000/editor |
| 最新发布快照 JSON | http://localhost:3000/api/public/chronicle |

编辑者口令默认在 `docker-compose.yml` 中为 `change-me-please`，**请修改后使用**：在编辑台右上角输入口令并保存（仅保存在该浏览器 localStorage 中，请求以 `X-Editor-Token` 头发送）。

停止与查看日志：

```bash
docker compose logs -f
docker compose down            # 保留数据卷
docker compose down -v         # 同时删除数据库数据卷
```

## 不用 Docker，本机直接运行

要求 Node.js ≥ 20。

```bash
npm install
npm start                     # 默认 http://localhost:3000
# 可选：写入演示草稿
npm run seed
npm test                      # 运行求解器与接口测试
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（本机直跑可设 `127.0.0.1`） |
| `EDITOR_TOKEN` | `editor` | 编辑者口令，生产使用务必修改 |
| `DB_PATH` | `./data/chronicle.db`（容器内 `/app/data/chronicle.db`） | SQLite 数据库文件路径，目录自动创建 |
| `SEED_DEMO` | 未设置 | 设为 `1` 时启动写入演示草稿（仅在库为空时） |
| `SCHEDULE_TICK_MS` | `1000` | 预约发布到期检查间隔（毫秒）；每次服务启动都会立即补跑一次到期预约 |

改端口示例：

```bash
PORT=8080 EDITOR_TOKEN=my-secret npm start
# 访客 http://localhost:8080/ ，编辑 http://localhost:8080/editor
```

## 使用方式

### 编辑（http://localhost:3000/editor）

1. 右上角输入编辑者口令并保存。
2. 在「事件与时间主张」中添加事件；每个事件可添加**任意多条**时间主张，每条必须填写出处（受访人 / 访谈时间 / 档案全宗 / 页码等），矛盾说法可用「考异备注」记录。
3. 用单选按钮为**每个**事件选定一条拟发布主张（选择只保存在当前浏览器中）。
4. 在「先于」关系中声明 A 严格先于 B，可附出处。
5. 「校验能否发布」先预览；「发布新版本」正式生成不可变快照。也可以「预约发布」：指定一个**未来 UTC 时刻**，系统在到期时自动尝试发布（见下节）。
6. 两人同时整理草稿时，用「并行编辑会话」卡片各自开启会话：修改先暂存，提交时三方合并（自动合并未触及的字段，冲突整次拒绝并逐项列出），详见「并行编辑会话」一节。

### 发布规则（为什么会发布失败）

粗精度日期按其覆盖的闭区间处理：

- 精确到**年**（如「1958 年」）：区间 `1958-01-01 ~ 1958-12-31`
- 精确到**月**（如「1958 年 3 月」）：区间 `1958-03-01 ~ 1958-03-31`
- 精确到**日**：区间即当天

发布时，系统为每个事件在其选定主张的区间内确定一个**具体日期**，并要求每条「先于」关系两端**严格相差至少一天**（不允许同一天）。以下情况会拒绝发布，错误面板会标明涉事事件与关系（点击可定位），**上一已发布版本保持不变**：

1. **缺少主张**：有事件未选定主张（或选定了已删除 / 不属于该事件的主张）；
2. **关系成环**：「先于」关系构成有向环（含自环，自环在录入时即被禁止）；
3. **时间无解**：区间内不存在满足全部严格先后关系的具体日期。错误信息会给出一条导致矛盾的见证链，例如「冬月会议 先于 春月会议」却分别主张 1958 年 12 月、1958 年 1 月。

发布成功后得到递增版本号（第 1 版、第 2 版……），事件、所选主张（精度、区间、出处、考异）、关系与求解日期全部**复制进版本快照**；此后修改草稿不影响任何旧版本。访客页只展示当前最新版本。

### 预约未来时刻（UTC）自动发布

除即时发布外，编辑者可为**通过现有发布校验的草稿**选定每事件主张，并指定一个**未来 UTC 时间**预约发布：

- **建立即冻结**：预约成功时，系统把当时的**事件、每事件所选主张、「先于」关系、求解日期**与**当前最新版本号（冻结基准版本号）**整体复制进预约。此后编辑者修改草稿、增删主张、从历史版本恢复草稿，**都不改变预约内容**；到期前访客仍只见当前最新版本。
- **建立即校验**：时间必须是合法的未来 UTC 时刻（形如 `2026-10-02T12:34:00Z`，只接受 `Z` 结尾；秒可省略）。时间非法或已过期返回 **400**（`INVALID_SCHEDULED_TIME`）；主张选择为空 **400**；草稿不能通过现有发布校验（缺主张 / 成环 / 时间无解）返回 **422**（与即时发布同一错误结构）；`baseVersionNo` 不等于当前最新版本号返回 **409** `VERSION_CONFLICT`；**两个服务进程共用同一库时**，若读取草稿与提交之间草稿被另一进程改动，返回 **409** `DRAFT_REVISION_CONFLICT`（与即时发布同一草稿冲突语义，见下节）。**以上情况都不建立预约**。
- **到期执行**：调度器在服务启动时立即补跑一次（停机期间到期的预约不丢失），之后每 1 秒检查一次（可用 `SCHEDULE_TICK_MS` 调整）。到期的待执行预约按**预约时间、预约号顺序**逐条处理：
  - 仅当**冻结的基准版本号仍等于当前最新版本号、且该基准版未被撤回**时，用冻结内容在一个事务内**生成一个不可变新版本**（写版本与翻转预约状态同事务，失败整体回滚，绝不留半版）；
  - 否则把预约标记为 **冲突（conflict）**：**不发布、不自动改基准**，冻结的完整内容保留在预约详情中供编辑者查看，编辑者可核对后即时发布或另建预约。**以已撤回版为冻结基准的预约到期同样转冲突**（撤回与到期发布竞争时按事务提交顺序裁决：撤回先提交则预约转冲突；发布先提交则新版本保留，撤回仅作用指定版）。
- **幂等与重启安全**：重启服务或重复触发都**不会重复发布**——只有 `pending`（待执行）状态的预约会被处理，已发布 / 冲突 / 已取消的预约永不再执行。
- **查看与取消**：编辑者在工作台「发布」卡片中可查看全部预约（待执行的在前，显示倒计时、冻结基准版本号与冻结事件摘要）、展开冻结详情。**尚未执行的预约可随时取消**（取消幂等）；**已生效（已发布 / 冲突）的预约不能取消**（409 `SCHEDULE_NOT_CANCELLABLE`）。
- 预约生成的新版本与即时发布完全同源（同一快照构造与求解逻辑），**公开读取继续应用出处遮盖**；即时发布、历史版本读取与原有接口保持兼容。

```bash
TOKEN=editor
BASE=http://localhost:3000
# 先用现有接口取草稿事件/主张，组装 selection（与即时发布相同）
# 建立 5 分钟后到期的预约（时间必须是未来 UTC，Z 结尾）
AT=$(node -e 'console.log(new Date(Date.now()+300000).toISOString().replace(/\.\d{3}Z$/,"Z"))')
curl -s -X POST "$BASE/api/editor/schedules" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"selection":[{"eventId":1,"claimId":1},{"eventId":2,"claimId":3}],
       "scheduledAt":"'"$AT"'","baseVersionNo":2,
       "editor":"志愿者小王","note":"纪念日后自动公开"}'
# => 201 {"ok":true,"schedule":{"scheduleNo":1,"scheduledAt":"…Z","status":"pending",
#        "baseVersionNo":2,"frozen":{"events":[…含求解日期…],"relations":[…]}, ...}}

curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/schedules"           # 预约列表
curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/schedules/1"         # 冻结内容详情
curl -s -X DELETE -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/schedules/1"  # 到期前取消
```

到期后预约详情的 `status` 变为 `published`（附 `resultVersionNo`）或 `conflict`（附 `resultMessage`，冻结内容仍在 `frozen` 中）。完整可运行的端到端示例见 `examples/schedule-example.sh`（建预约、改草稿验证冻结、等待自动发布、抢先发布触发冲突、取消与各类 400/409/422，约 25 秒）。

### 长链草稿（数千事件逐日相接）

编辑者分批整理出**逐日相接的数千个事件**（如 6000 个事件、5999 条「先于」关系连成一条链）时，校验、即时发布与预约建立都在秒级完成，且三个入口对同一草稿的求解结果**逐事件一致**。求解器全程为迭代实现（成环检测用显式栈的 Tarjan SCC、拓扑排序用头指针队列），**不会因链长触发调用栈溢出**；链长只受草稿规模本身限制。

- **可解时**：每个事件的求解日期仍落在其选定主张的覆盖区间内，每条「先于」关系两端严格相差至少一天（与短草稿完全同一套规则）。
- **无解时**：错误类型与见证信息不变——`cycle` 列出成环的涉事事件与关系，`temporal` 给出一条导致矛盾的见证链；校验（`POST /api/editor/validate` 返回 `ok:false`）、即时发布（**422**）、预约建立（**422**）按各自既有结构反馈，且**都不写入版本或预约**。
- 基准版本冲突（**409**）、不可变快照与公开读出规则与短草稿一致。

大批量录入建议走「采访整理包导入」（见下节）：把事件分批（如每批 2000 个，单个请求体须小于 1 MB）导入，再补跨批的衔接关系。本轮调用示例（假设草稿已是 6000 事件长链，每事件一条主张）：

```bash
TOKEN=editor
BASE=http://localhost:3000
# selection：每事件选定一条主张（与短草稿同一格式，可用导入返回的 idMap 组装）
SEL='[{"eventId":1,"claimId":1},{"eventId":2,"claimId":2}, … {"eventId":6000,"claimId":6000}]'

# 1) 校验：ok:true 时 preview 给出 6000 个求解日期（首日 1950-01-01、末日 1966-06-05）
curl -s -X POST "$BASE/api/editor/validate" -H "Content-Type: application/json" \
  -H "X-Editor-Token: $TOKEN" -d '{"selection":'"$SEL"'}'
# => {"ok":true,"preview":[{"eventId":…,"resolvedDate":"1950-01-01",…}, …]}

# 2) 即时发布：201，版本含全部 6000 事件 / 5999 关系，求解日期与校验预览一致
curl -s -X POST "$BASE/api/editor/publish" -H "Content-Type: application/json" \
  -H "X-Editor-Token: $TOKEN" \
  -d '{"selection":'"$SEL"',"baseVersionNo":0,"editor":"志愿者小王","note":"长链首版"}'

# 3) 预约建立：201，冻结内容中的求解日期与即时发布逐事件一致
AT=$(node -e 'console.log(new Date(Date.now()+300000).toISOString().replace(/\.\d{3}Z$/,"Z"))')
curl -s -X POST "$BASE/api/editor/schedules" -H "Content-Type: application/json" \
  -H "X-Editor-Token: $TOKEN" \
  -d '{"selection":'"$SEL"',"scheduledAt":"'"$AT"'","baseVersionNo":1}'
```

完整可运行的端到端示例见 `examples/long-chain-example.sh`（分批导入 6000 事件长链 → 校验/发布/预约三方一致性 → 成环与时间无解的失败一致性 → 预约到期自动发布比对，约 30 秒；可用 `N=6000 BATCH=2000` 调整链长与批大小）。

### 从历史版本恢复草稿（预览 → 确认）

编辑台右侧「已发布版本」中，每个版本都有「预览并恢复草稿」按钮。恢复**不产生新版本、不改动任何历史快照**，只替换草稿区：

1. **预览（只读）**：弹窗双栏列出——
   - 该版的事件、每个事件在**当版被选的那一条时间主张**（精度、区间、出处、考异）、全部「先于」关系；
   - 当前草稿中将被替换掉的全部事件（含全部主张）与关系，以及草稿修订号、最新版本号。
   预览**不写任何数据**：目标版本、当前草稿（全部事件 / 主张 / 关系）、草稿修订号与最新版本号在**同一个只读事务（同一数据库快照）**内读出，四者严格对应同一数据库状态。两个服务进程共用同一库时，另一进程即使在预览读取过程中写入事件 / 主张 / 关系或发布新版本，整份预览也只会整体落在其提交前或提交后的快照上，**不会出现「展示旧草稿内容却返回新修订号 / 新版本号」的混合结果**（也就不会在随后确认时误删预览未展示的改动）。
2. **确认恢复**：请求必须提交预览时返回的**草稿修订号**与**最新版本号**。确认在一个 **BEGIN IMMEDIATE 写事务**（先取写锁）内完成：重新核对最新版本号、草稿修订号与目标版本，随后**原子替换整个草稿**——清空当前草稿的事件 / 主张 / 关系，按该版快照重建，并**只恢复当版被选的主张**（同一事件其它未选主张不恢复）；返回的新草稿全貌、修订号、最新版本号同样取自同一事务。返回：
   - 旧快照 id → 新草稿 id 的映射（事件、主张、关系）；
   - 每事件一条的**待选主张**，编辑台据此自动填好单选；
   - 新草稿修订号（每次恢复只推进一次修订号）。
3. **冲突保护**：确认前若草稿被任何人增删改过（修订号变化），或期间发布了更新的版本（最新版本号变化），返回 **409**（`DRAFT_REVISION_CONFLICT` / `VERSION_CONFLICT`）且**整次不改动任何数据**，需重新预览再确认；确认时另一进程正持有写锁（等不到锁）同样按 `DRAFT_REVISION_CONFLICT` 返回 409，不会透出底层锁错误；目标版本不存在返回 404（预览与确认一致）。

草稿的任何增、删、改都会推进草稿修订号（含恢复本身）。恢复后：

- **历史快照与访客年表保持不变**（访客仍看当前最新发布版）；
- 草稿仅含该版内容，仍需「校验能否发布」后正式发布才会公开；
- 发布仍遵守现有编辑口令、求解校验与 `baseVersionNo` 冲突约定——恢复的是更旧的版本时，请以**当前最新版本号**为 `baseVersionNo` 发布，否则同样收到 409。

**两名编辑者（或两个服务进程）共用同一库时的调用约定**：预览返回的四个值同源，客户端只需原样回传，冲突后重新预览重试即可：

```bash
BASE=http://localhost:3000
TOKEN=editor

# 甲：预览（只读；draftRevisionNo / currentVersionNo 与所展示草稿来自同一数据库状态）
PV=$(curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/restore-preview/1")
echo "$PV" | jq '{versionNo, draftRevisionNo, currentVersionNo, currentDraft: .currentDraft.counts}'

# …此间乙通过任一进程改了草稿（POST/PUT/DELETE /api/editor/...）或发布了新版本…

# 甲：用预览返回的两个号码原样确认
curl -s -X POST "$BASE/api/editor/restore" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d "$(echo "$PV" | jq -c '{versionNo, draftRevisionNo, currentVersionNo}')"
# 乙改过草稿  => 409 {"code":"DRAFT_REVISION_CONFLICT","currentRevisionNo":…}（整次不改库）
# 乙发过新版  => 409 {"code":"VERSION_CONFLICT","currentVersionNo":…}       （整次不改库）
# 目标版不存在 => 404（预览与确认一致）；撤回版仍可恢复（预览响应附 retraction）

# 甲：重新预览（号码与展示内容再次同源）后原样回传 => 200，草稿原子替换
PV=$(curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/restore-preview/1")
curl -s -X POST "$BASE/api/editor/restore" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d "$(echo "$PV" | jq -c '{versionNo, draftRevisionNo, currentVersionNo}')"
```

完整可运行的端到端示例见 `examples/concurrent-restore-example.mjs`（自动拉起两个共用同一 `DB_PATH` 的服务进程，只走编辑者 HTTP API：预览后改草稿的 409 与重试成功、预览后发新版的 409、另一进程持续写入时逐轮预览「内容与修订号同源」、从已撤回版恢复而访客视图不变，约 5 秒；可用 `ROUNDS=24` 调整交错轮数）。

### 导入采访整理包（JSON，预览 → 确认）

编辑者可在工作台「导入采访整理包」卡片中上传 `.json` 文件或粘贴 JSON，也可直接调用 HTTP API。整理包格式（完整示例见 `examples/interview-bundle.example.json`）：

```json
{
  "batchId": "2026-09-dongganqu-fangtan-01",
  "events": [
    {
      "key": "dongyuan-hui",
      "title": "修水渠动员会",
      "description": "可选",
      "claims": [
        { "precision": "day", "year": 1958, "month": 9, "day": 12, "source": "李宝山口述，2021-07-05 访谈", "note": "可选考异" },
        { "precision": "year", "year": 1958, "source": "《县水利志》1994 年版，第 87 页" }
      ]
    },
    {
      "key": "tongshui",
      "title": "东干渠通水",
      "claims": [ { "precision": "month", "year": 1959, "month": 5, "source": "王秀兰口述" } ]
    }
  ],
  "relations": [
    { "earlierKey": "dongyuan-hui", "laterKey": "tongshui", "source": "二人口述一致" }
  ]
}
```

- `batchId`：批次标识，**已成功导入过的批次不能再次导入**；
- 每个事件以包内唯一键 `key` 标记，至少一条时间主张；主张字段与手工录入一致（`precision` 为 `year`/`month`/`day`，`source` 出处必填）；
- `relations` 可省略，用 `earlierKey`/`laterKey` 按键引用事件，表示「先于」。

流程与恢复草稿类似，分两步：

1. **预览（只读）**：`POST /api/editor/import-preview`，请求体即整理包 JSON。返回待写入的事件 / 主张 / 关系内容与数量、`fingerprint`（内容指纹）、`draftRevisionNo`（当前草稿修订号），不写任何数据。**键重复、关系引用缺失（指向包内不存在的键）、日期或出处非法**等问题会一次性全部列出，并以 **422** 整包拒绝：

   ```bash
   curl -s -X POST http://localhost:3000/api/editor/import-preview \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
     --data-binary @examples/interview-bundle.example.json
   # => {"ok":true,"batchId":"...","fingerprint":"cbf008...","draftRevisionNo":0,
   #     "alreadyImported":null,"counts":{"eventCount":2,"claimCount":3,"relationCount":1},
   #     "events":[...],"relations":[...]}
   ```

2. **确认导入**：`POST /api/editor/import`，必须提交**原包**、预览返回的**内容指纹**和**草稿修订号**。成功时在**一个事务**中把整包**追加**进草稿区（既有草稿、历史快照、访客视图均不受影响），返回包内键 → 草稿 ID 的映射与新修订号（整包只推进一次修订号）：

   ```bash
   # 用预览返回的 fingerprint 与 draftRevisionNo 组装确认请求（示例借助 jq）
   PREVIEW=$(curl -s -X POST http://localhost:3000/api/editor/import-preview \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
     --data-binary @examples/interview-bundle.example.json)
   jq -n --argjson p "$PREVIEW" --slurpfile b examples/interview-bundle.example.json \
     '{bundle: $b[0], fingerprint: $p.fingerprint, draftRevisionNo: $p.draftRevisionNo}' \
   | curl -s -X POST http://localhost:3000/api/editor/import \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" --data-binary @-
   # => 201 {"ok":true,"batchId":"...","revisionNo":1,"counts":{...},
   #     "idMap":{"events":[{"key":"dongyuan-hui","eventId":1,"claimIds":[1,2]},...],
   #              "relations":[{"earlierKey":"dongyuan-hui","laterKey":"tongshui","relationId":1}]}}
   ```

   确认在以下情况返回 **409 且不写入任何数据**（需重新预览后再确认）：
   - `BUNDLE_CONTENT_MISMATCH`：提交的包与预览指纹不符（内容被替换）；
   - `DRAFT_REVISION_CONFLICT`：预览后草稿被任何人增删改过；
   - `BATCH_ALREADY_IMPORTED`：批次标识曾成功导入（失败的确认不留记录，可修正后重试）。

导入的内容只是草稿：仍需在编辑台为每个事件**选定主张**、通过现有「校验能否发布」（含先后关系求解）后正式发布，访客才能看到。

### 按出处原文撤回公开展示（出处遮盖，预览 → 确认）

受访人或档案方要求撤回某条出处的公开展示时，编辑者可按**出处原文**遮盖。适用于已发布快照中**事件主张的出处**与**「先于」关系的出处**（含专题路线读出的出处与勘误附记出处）。

**匹配规则（首尾空白折叠，内部逐字精确）**：手工录入、整理包导入、并行会话保存的出处都可能带**首尾空白**（导入 / 会话 / 关系录入原样保留 `source`），编辑者粘贴的预览文本通常没有。因此系统对**登记文本与库存出处各自做首尾空白折叠**（`trim()`：去除两端全部空白字符——空格、制表、换行、全角空格等）后再做**严格相等**比较：

- 仅首尾空白不同的写法视为同一出处：库存 `"  受访人李某  "`、`"\t受访人李某\n"` 与提交的 `"受访人李某"` **互相命中**；
- **内部空白与其他文字仍逐字精确区分**：`trim` 不触碰字符串内部，`"受访人 李某"` ≠ `"受访人  李某"`（中间两个空格）、`"李某"` ≠ `"李某 续"`，部分包含不命中；
- 空 / 纯空白文本不能登记（400），故快照中的空出处永远不会被遮盖。

预览与确认的命中范围、访客遮盖、专题路线、勘误附记与以后发布的公开读出全部按同一规则判定；编辑者原文视图（版本原文、路线原文、附记链、草稿、恢复预览）仍显示库存原文。

1. **预览（只读）**：在编辑台「按出处原文撤回公开展示」卡片粘贴**非空的出处文本**（首尾空白会被折叠；内部空白与其他文字须与库存出处逐字一致，部分包含不命中），或调用 `POST /api/editor/redaction-preview`。返回折叠后的规范文本 `source`、该文本在**全部已发布版本**中命中的位置与数量（按版本列出事件主张命中与关系命中，每条命中附库存实际保存的出处原文 `source`，便于核对首尾空白变体）、当前最新版本号 `currentVersionNo`；另附草稿区命中条数与库存原文供参考。预览不写任何数据。
2. **确认遮盖**：`POST /api/editor/redaction`，必须提交原文与预览时的**最新版本号** `currentVersionNo`。系统把文本 `trim` 成规范文本后在 `source_redactions` 表**追加登记**：

   - **不改写任何历史快照或草稿**（版本快照表、草稿表里带首尾空白的 `source` 原文原样保留）；
   - 访客读取**最新年表**、**指定历史版本**、**专题路线**与**勘误附记**时，凡库存出处折叠后等于登记文本，`source` 一律显示为统一的 **「出处已遮盖」**，其余字段（标题、日期、区间、求解日期、考异等）与版本号不变；
   - **以后发布（含即时发布、预约发布、恢复草稿后再发布）含同一文本或其首尾空白变体的新版本也自动遮盖**（读出时动态比对登记文本，无需逐版处理）；
   - 持编辑口令查看版本详情（`GET /api/editor/versions/:no/raw`、编辑台「查看该版快照原文」）**仍显示库存原文**；**从历史版本恢复草稿也使用原文**；
   - 遮盖登记不推进草稿修订号，与恢复 / 导入的并发控制互不影响。
3. **冲突与幂等**：预览后若有人发布了新版本（最新版本号变化），确认返回 **409** `VERSION_CONFLICT` 且**不落库**，需重新预览再确认；空 / 纯空白文本返回 **400**；折叠后同一文本**重复确认**（无论是否带首尾空白）返回 **200** 且 `alreadyRedacted: true`（已遮盖状态与当前命中数量，不重复登记）。

   ```bash
   TOKEN=editor
   SRC='李宝山口述，2021-07-05 访谈'

   # 1) 只读预览：命中位置与数量 + 最新版本号
   curl -s -X POST http://localhost:3000/api/editor/redaction-preview \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
     -d "{\"source\":\"$SRC\"}"
   # => {"ok":true,"source":"李宝山口述…",            // trim 折叠后的规范文本
   #     "alreadyRedacted":false,
   #     "currentVersionNo":2,"versionCount":2,
   #     "totalEventHitCount":3,"totalRelationHitCount":2,"totalHitCount":5,
   #     "versions":[{"versionNo":1,"eventHitCount":1,"relationHitCount":1,
   #                  // 每条命中附库存实际保存的出处原文（可能带首尾空白）
   #                  "eventHits":[{"eventId":1,"title":"动员会","source":"  李宝山口述…  ",...}],
   #                  "relationHits":[{"relationId":1,"earlierEventId":1,"laterEventId":2,"source":"李宝山口述…"}]},
   #                 {"versionNo":2,...}],
   #     "draft":{"claimHitCount":0,"relationHitCount":0,...}}

   # 2) 携预览返回的最新版本号确认（示例用 jq 取号）
   PREVIEW=$(curl -s -X POST http://localhost:3000/api/editor/redaction-preview \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
     -d "{\"source\":\"$SRC\"}")
   curl -s -X POST http://localhost:3000/api/editor/redaction \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
     -d "{\"source\":\"$SRC\",
          \"currentVersionNo\":$(echo "$PREVIEW" | jq .currentVersionNo),
          \"editor\":\"志愿者小王\"}"
   # => {"ok":true,"alreadyRedacted":false,"redactedLabel":"出处已遮盖",
   #     "currentVersionNo":2,"totalHitCount":5,...}

   # 3) 访客视图：命中处显示「出处已遮盖」（最新年表与任一历史版本皆然）
   curl -s http://localhost:3000/api/public/chronicle | jq '.version.events[].source'
   curl -s http://localhost:3000/api/public/versions/1 | jq '.version.relations[].source'

   # 4) 持口令的版本原文不变
   curl -s -H "X-Editor-Token: $TOKEN" \
     http://localhost:3000/api/editor/versions/1/raw | jq '.version.events[].source'
   ```

   完整可运行的调用示例见 `examples/redaction-example.sh`（自动建草稿、发布两版、预览、确认、核对访客视图与原文视图）。

### 撤回已发布版本（按版本号撤回整版公开展示）

编辑者发现某版年表的**编年依据错误**时，可按**版本号**与**非空原因**撤回该版的公开展示（编辑台「已发布版本」中每版的「撤回该版」按钮，或直接调用 HTTP API）：

- **只追加审计记录**：撤回只在 `version_retractions` 表追加一条记录（版本号、原因、编辑者、时间），**历史快照与版本号不改**（`versions / version_events / version_relations` 原样保留），草稿也不受影响。
- **访客视图即时生效**：
  - 访客最新年表指向**编号最大的未撤回版**；若全部已发布版本都被撤回，显示**「尚无可读版本」**；
  - 访客版本清单不含撤回版；访客读取指定撤回版、以及**引用撤回版的专题路线**，一律**按不存在处理**（404）；
  - 未撤回版的接口结构与出处遮盖规则完全不变。
- **编辑者视图不受影响**：持口令仍可查看撤回版**快照原文**（`GET /api/editor/versions/:no/raw`，响应附 `retraction`）、撤回原因（版本清单与 `GET /api/editor/retractions`）与相关路线（路线清单项标 `versionRetracted`）；从撤回版**恢复草稿**依然可用（预览响应附撤回提示）。
- **重复撤回幂等**：同一版本再次撤回返回 **200** 且 `alreadyRetracted: true`，内容为**首次记录**，原因不被覆盖、不重复落库。
- **非法请求不改状态**：版本不存在 **404**；原因为空 / 纯空白 / 非字符串 / 超长（>1000）或版本号非法 **400**；均不落库。
- **发布与预约基准不变**：即时发布与预约发布仍以**最高已发布版本号**（含撤回版）为 `baseVersionNo`，新版本号继续递增（撤回版不占号也不跳号）。**以已撤回版为冻结基准的待执行预约，到期转为冲突（conflict），不生成新版本**，冻结内容保留供查看。
- **撤回与到期发布竞争**：按事务提交顺序裁决——撤回先提交则预约到期转冲突；发布先提交则新版本保留，撤回仅作用于指定版。

```bash
TOKEN=editor
BASE=http://localhost:3000

# 撤回第 2 版（原因必填，首尾空白会被去除）
curl -s -X POST "$BASE/api/editor/versions/2/retract" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"reason":"动员会日期考证有误，需撤回修订","editor":"志愿者小王"}'
# => {"ok":true,"alreadyRetracted":false,
#     "retraction":{"versionNo":2,"reason":"…","editor":"…","retractedAt":"…"},
#     "currentVersionNo":2,          ← 发布基准（含撤回版的最高版本号）
#     "latestVisibleVersionNo":1}    ← 访客当前可见的最新版

# 重复撤回：幂等返回首次记录，不覆盖原因
curl -s -X POST "$BASE/api/editor/versions/2/retract" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"reason":"另一条原因"}'
# => {"ok":true,"alreadyRetracted":true,"retraction":{"reason":"动员会日期考证有误…"}}

# 访客视图：最新年表回退到第 1 版；撤回版详情 404；引用它的路线 404
curl -s "$BASE/api/public/chronicle"          # currentVersionNo = 1
curl -s "$BASE/api/public/versions"           # 清单只含未撤回版
curl -s "$BASE/api/public/versions/2"         # 404（按不存在处理）

# 编辑者视图：撤回版原文与原因、相关路线仍可见
curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/versions/2/raw"   # version 原文 + retraction
curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/retractions"      # 撤回清单

# 修正后重新发布：仍以最高已发布版本号（第 2 版）为基准，编号递增为第 3 版
curl -s -X POST "$BASE/api/editor/publish" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"selection":[…],"baseVersionNo":2,"note":"修正编年后的新版"}'
```

完整可运行的端到端示例见 `examples/retraction-example.sh`（建草稿发两版、建路线、撤回、访客/编辑者视图对照、幂等、基准版预约到期转冲突、修正后重新发布、全部撤回显示「尚无可读版本」，约 6 秒）。

### 勘误附记（对指定已发布版本的事件 / 「先于」关系登记附记）

某版年表发布后发现个别事件或「先于」关系需要补充勘误时，编辑者可在**不改动原快照**的前提下，对该版快照中的**事件**或**「先于」关系**登记**勘误附记**（编辑台「勘误附记」卡片，或直接调用 HTTP API）：

- **登记内容**：目标版号、该版快照对象编号（事件 id / 关系 id）、**勘误说明**与**出处**（均必填）。版本不存在 **404**、对象不属该版 **422**（`ERRATA_TARGET_NOT_IN_VERSION`）、目标版已撤回 **409**（`VERSION_RETRACTED`）、字段非法 **400**，均不落库。
- **只属于目标版**：附记登记在指定版本号上，**不随「从该版恢复草稿」或以后发布的新版本继承**；原快照、求解日期与草稿均不改动（不推进草稿修订号）。
- **同一目标只展示最新生效附记**：对同一目标再次登记即为**替代**——必须提交登记时所见的**生效附记号**（`replacesErrataId`）。事务内核对该目标当前生效附记号：不一致即 **409**（`ERRATA_CONFLICT`）并返回**当前生效附记**，**不落库**——两名编辑者同时替代时仅先提交者成功，冲突方取得当前附记后可再次提交。被替代的旧附记全部保留（`replaces_errata_id` 形成替代链），编辑者可查完整替代链供追溯。
- **访客可见、出处沿用遮盖规则**：访客读取**目标版**或**最新年表**时可见该版各目标的生效附记；附记出处沿用现有「按出处原文撤回公开展示」的遮盖规则——库存出处与登记文本各自 `trim` 折叠首尾空白后严格相等即命中（仅首尾空白不同视为同一出处，内部空白与其他文字逐字区分），命中显示「出处已遮盖」，读出时动态比对。编辑者持口令可查**原文**及替代链。
- **撤回联动**：目标版被撤回后不能再对其登记；访客不再看到该版及其附记（随版本读出层隐藏），编辑者仍可查该版附记原文与替代链。

```bash
TOKEN=editor
BASE=http://localhost:3000

# 1) 对第 1 版中的事件 3 登记附记（目标尚无附记时不需 replacesErrataId）
curl -s -X POST "$BASE/api/editor/errata" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"versionNo":1,"targetType":"event","targetId":3,
       "note":"动员会日期应为 1958-09-13，口述记忆有误",
       "source":"《县水利志》1994 年版，第 87 页","editor":"志愿者小王"}'
# => 201 {"ok":true,"errata":{"errataId":1,"versionNo":1,"targetType":"event","targetId":3,
#        "note":"…","source":"…","replacesErrataId":null,"createdAt":"…"},"replaced":null}

# 对「先于」关系登记：targetType 改为 relation，targetId 为该版快照中的关系 id
curl -s -X POST "$BASE/api/editor/errata" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"versionNo":1,"targetType":"relation","targetId":4,
       "note":"该先后关系另有反证待核","source":"张德福口述，2022-03-11 访谈"}'

# 2) 替代附记：须提交所见附记号（两人同时替代仅一个成功，冲突方 409 取得当前附记且不落库）
curl -s -X POST "$BASE/api/editor/errata" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"versionNo":1,"targetType":"event","targetId":3,
       "note":"更正：应为 1958-09-14","source":"某档案，第 12 页",
       "replacesErrataId":1,"editor":"志愿者小李"}'
# => 201 {"ok":true,"errata":{"errataId":3,"replacesErrataId":1,...},"replaced":{"errataId":1,...}}
# 冲突时 => 409 {"code":"ERRATA_CONFLICT","current":{"errataId":3,"note":"更正：应为 1958-09-14",...}}

# 3) 访客读取目标版 / 最新年表：version.errata 即该版各目标的生效附记（出处按遮盖规则显示）
curl -s "$BASE/api/public/versions/1" | jq '.version.errata'
curl -s "$BASE/api/public/chronicle"  | jq '.version.errata'

# 4) 编辑者查阅：该版全部附记（按目标分组，含替代链，原文不遮盖）；单条附记的替代链
curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/versions/1/errata"
curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/errata/1"
```

完整可运行的端到端示例见 `examples/errata-example.sh`（建草稿发两版、登记事件与关系附记、新版不继承、替代与并发冲突、出处遮盖联动、撤回版拒绝登记与视图对照，约 3 秒）。

### 专题「先于」脉络路线

编辑者可从一份**已发布年表**中按顺序挑选至少两个互异事件作为**锚点**，填写专题标题，形成一条可公开的脉络路线（编辑台「专题『先于』脉络路线」卡片，或直接调用 HTTP API）：

- **连通要求**：相邻两个锚点必须在该版「先于」关系图中存在**有向路径**（沿 较早→较晚 方向）。每段路线展示一条**关系数最少**的见证链；长度相同时按**关系 ID 序列**字典序择小。见证链可能经过未列为锚点的**中间事件**。
- **断点拒绝**：任何一段无法连通即**拒绝整条路线**（不落库），错误中列出全部断点（段序号与两端事件）；未知版本（404）、事件不在该版（422）、重复事件或锚点不足两个（400）同样不保存。
- **建立即冻结**：路线把**所据版本号、锚点顺序、每段见证链**整体写入只追加的路线表。此后修改草稿、从历史版本恢复草稿、发布新版本，**都不改变旧路线**（路线展示字段读自该版不可变快照）。
- **公开查看**：访客年表页「专题脉络路线」卡片列出全部路线；路线详情**区分锚点与链上中间事件**，且**只展示路线涉及的事件与关系**；出处按现有公开遮盖规则显示（命中登记的位置显示「出处已遮盖」）。**引用已撤回版本的路线对访客隐藏**（清单不含、详情 404）；编辑者持口令经 `GET /api/editor/routes/:no/raw` 或编辑台「查看路线」查看**原文**（清单项以 `versionRetracted` 标记）。

```bash
TOKEN=editor
BASE=http://localhost:3000

# 从第 2 版年表中挑 3 个锚点（按路线顺序），建立路线
curl -s -X POST "$BASE/api/editor/routes" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"title":"东干渠建设脉络","versionNo":2,
       "anchorEventIds":[3,7,9],
       "editor":"志愿者小王","note":"纪念日专题"}'
# => 201 {"ok":true,"route":{"routeNo":1,"title":"东干渠建设脉络","versionNo":2,
#        "anchors":[{"position":0,"eventId":3,...},...],
#        "segments":[{"position":0,"fromEventId":3,"toEventId":7,
#                     "eventIds":[3,5,7],"relationIds":[4,8]},   ← 最少关系数见证链
#                    ...],
#        "events":[{"eventId":3,"role":"anchor","anchorPosition":0,...,"source":"..."},
#                  {"eventId":5,"role":"intermediate","anchorPosition":null,...}],
#        "relations":[{"relationId":4,"earlierEventId":3,"laterEventId":5,"source":"..."}]}}

# 无法连通：422，指出断点，整条不保存
# => {"status":422,"code":"ROUTE_INVALID",
#     "message":"路线无法连通：1 个相邻锚点之间在该版关系图中没有有向路径，整条路线未保存",
#     "errors":[{"type":"disconnected","segmentIndex":1,"eventIds":[7,9],
#                "message":"第 2 段断点：「…」与「…」在第 2 版的「先于」关系图中没有有向路径"}]}

curl -s "$BASE/api/public/routes"                 # 路线清单（公开）
curl -s "$BASE/api/public/routes/1"               # 路线详情（公开，出处按遮盖规则显示）
curl -s -H "X-Editor-Token: $TOKEN" \
     "$BASE/api/editor/routes/1/raw"              # 路线详情原文（持口令，不遮盖）
```

完整可运行的端到端示例见 `examples/route-example.sh`（建草稿发布、三锚点路线、关系 ID 择小、遮盖联动、改草稿发新版验证路线不变、各类 400/404/422）。

#### 长链路线（两万事件顺链的首尾为锚点）

从**逐日相接的两万个事件**构成的已发布年表中挑首尾两个事件作锚点时，见证链求解仍为**秒级内**完成：求解器是「正 / 反向 BFS 定层 + 逐层最小关系 ID 贪心 + 父指针回溯」的**线性实现**（O(事件数+关系数)），**不逐层复制整条路径**（旧做法链长 L 时单段即复制 O(L²) 个元素，耗时随链长平方增长）。选择规则与短链完全同一套：

- 每段仍是该版「先于」图中**关系数最少**的见证链，同长度按**关系 ID 序列**字典序择小；
- 任一段不可达仍**整条拒绝**（422 `ROUTE_INVALID`，错误逐项列出段号与两端事件，不落库）；
- 成功即冻结所据版本号、锚点顺序与各段见证链，此后改草稿、恢复草稿、发新版都不影响旧路线；
- 访客读取仍按出处遮盖（命中处显示「出处已遮盖」）与撤回版隐藏（清单不含、详情 404）规则，编辑者持口令看原文。

本轮调用示例（假设第 1 版已是 20000 事件顺链，事件 id 1..20000 依次相接）：

```bash
TOKEN=editor
BASE=http://localhost:3000

# 以首尾事件为锚点建立路线：唯一段即贯穿全链的最少关系见证链（20000 事件 / 19999 关系）
curl -s -X POST "$BASE/api/editor/routes" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"title":"两万里脉络","versionNo":1,
       "anchorEventIds":[1,20000],
       "editor":"志愿者小王","note":"长链专题"}'
# => 201 {"ok":true,"route":{"routeNo":1,"versionNo":1,
#        "anchors":[{"position":0,"eventId":1,...},{"position":1,"eventId":20000,...}],
#        "segments":[{"position":0,"fromEventId":1,"toEventId":20000,
#                     "eventIds":[1,2,…,20000],"relationIds":[1,2,…,19999]}],
#        "events":[…20000 个，首尾 role:"anchor"，其余 role:"intermediate"…],
#        "relations":[…19999 条…]}}

# 断点仍整条拒绝：若事件 20001 在该版中无任何「先于」关系
curl -s -X POST "$BASE/api/editor/routes" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"title":"x","versionNo":1,"anchorEventIds":[1,20001,20000]}'
# => 422 {"code":"ROUTE_INVALID",
#     "errors":[{"type":"disconnected","segmentIndex":0,"eventIds":[1,20001],"message":"第 1 段断点：…"},
#               {"type":"disconnected","segmentIndex":1,"eventIds":[20001,20000],"message":"第 2 段断点：…"}]}
#    （整条路线未保存）
```

完整可运行的端到端示例见 `examples/route-long-chain-example.sh`（分批导入 20000 事件长链 → 发布 → 首尾锚点建路线并计时 → 中途锚点 → 断点 422 不保存 → 改草稿发新版验证路线不变 → 出处遮盖与撤回版隐藏的访客 / 编辑者视图对照，约 20 秒；可用 `N=20000 BATCH=2000` 调整链长与批大小）。

### 两名编辑者并发修改（版本冲突）

发布请求必须带 `baseVersionNo`（编辑台打开时自动记录当前最新版本号）。若两名编辑者都从第 N 版开始改，第一人发布产生第 N+1 版后，第二人仍以 `baseVersionNo=N` 提交时：

- 服务器返回 **409 版本冲突**，编辑台弹出冲突框，告知对方发布的第 N+1 版概况；
- **不会**静默覆盖对方版本；
- 第二人需点击「刷新到最新版本并重新确认选择」，重新核对每个事件的主张单选后再发布。

### 两个服务进程共用同一库时的草稿并发（草稿冲突）

当部署两个 `node src/server.js` 进程（容器副本 / 双机热备）指向**同一个 SQLite 文件**时，即时发布与建立预约都是「读取草稿 → 求解 → 写入」的长操作。本轮修复前，事件、主张、关系是分次读取的，另一进程若在读取之间**一次性改动事件与主张**，可能冻结一段**从未同时存在过的混合内容**；建立预约还可能在写事务里才取草稿修订号，把**旧快照记成新修订号**。

修复后，**一次发布 / 预约只使用同一草稿状态的事件、所选主张、关系、求解日期与修订号**：

1. **同一快照读取**：事件、全部主张、「先于」关系与草稿修订号在**同一个只读事务（同一 WAL 快照）**内读出，随后才求解；读取期间另一进程无论如何提交，本操作都不会拼出跨版本的混合草稿。
2. **写事务乐观复核**：写入以 `BEGIN IMMEDIATE` 开始（立即取得写锁），在插入版本 / 预约前再次核对**草稿修订号**与 `baseVersionNo`：
   - 草稿修订号已变（快照之后草稿被另一进程改过）→ **409 `DRAFT_REVISION_CONFLICT` 草稿冲突**，附 `expectedRevisionNo` 与 `currentRevisionNo`，**整次取消：不生成版本、不建立预约，也不会留下半成品**；编辑者刷新草稿、重新确认每事件主张后重试即可；
   - 草稿一致但 `baseVersionNo` 过期 → 仍是既有的 **409 `VERSION_CONFLICT`**（见上一节），响应结构与冻结语义不变；
   - 写锁等待超时（另一进程长时间占用写事务）同样归入 **409 草稿冲突**（无法取得一致草稿状态），语义同上。
3. **预约修订号与冻结快照同源**：建立预约时记录的 `draftRevisionNo` 就是读出冻结内容时那一版草稿的修订号（不再在写事务里另取新值），二者必然描述同一草稿状态；草稿冲突时预约整次不建立。

发布校验（422：缺主张 / 成环 / 时间无解）、预约到期处理（基准版本一致且未撤回才发布，否则转 `conflict` 保留冻结内容）、出处遮盖、版本撤回与既有冻结语义**全部保持不变**；编辑者 HTTP API 的路径、请求头（`X-Editor-Token`）、`selection` / `baseVersionNo` 参数也完全兼容，仅在并发命中时**新增**一种 409 响应码。

完整可运行的端到端示例见 `examples/concurrent-publish-example.mjs`：脚本自动拉起**两个共享同一 `DB_PATH` 的服务进程**，只用编辑者 HTTP API 铺一条长链草稿，然后演示——

```bash
node examples/concurrent-publish-example.mjs
# 可选 N=8000（长链规模，越大越容易撞上求解窗口）、PORT_A/PORT_B 指定端口、KEEP=1 保留现场
```

- 场景一：两个进程**同时基于同一 `baseVersionNo` 发布** → 一个 201 生成新版本，另一个 409 `VERSION_CONFLICT`，无静默覆盖；
- 场景二：一个进程**发布 / 建立预约的求解窗口内**，另一进程改草稿并提交 → 前者 409 `DRAFT_REVISION_CONFLICT`（给出 `expectedRevisionNo → currentRevisionNo`），版本数 / 预约数均不增加；刷新草稿重新确认选择后重试 201 成功。

> 单个 Node 进程内 better-sqlite3 调用是同步的，HTTP 请求处理互不交错；草稿冲突只在**多进程共用同一库**时可能发生，这也是示例要启动两个进程的原因。手工复现可用两个终端：一边对数千事件的长链调 `POST /api/editor/publish`（或 `/api/editor/schedules`），另一边几乎同时 `PUT /api/editor/events/:id` 改草稿。

### 两个服务进程共用同一库时的恢复预览 / 确认（预览四值同源）

「从历史版本恢复草稿」是**预览 → 确认**两步操作，两步之间不持锁。修复前，预览把「将被替换的草稿（事件 / 主张 / 关系）」「草稿修订号」「最新版本号」**分次独立读取**（每条 SELECT 各取最新 WAL 快照）：另一进程若恰在「读草稿」与「读修订号」之间写入事件 / 主张 / 关系（或发布新版本），预览可能**展示旧草稿内容却返回新修订号 / 新版本号**；确认按这组新号码校验会通过，于是清空草稿时把**预览中从未展示过的对方改动一并删除**。

修复后（与发布路径同一套并发原则）：

1. **预览同一快照、本身只读**：目标版本、当前草稿（**全部**事件 / 主张 / 关系）、草稿修订号、最新版本号在**同一个只读事务（同一 WAL 快照）**内读出，四值对应同一数据库状态。另一进程在预览读取窗口内提交，只会让整份预览整体落在提交前或提交后的快照上，绝不返回新旧混合结果；预览只发 SELECT，不推进修订号、不留任何写入。
2. **确认取写锁后再复核**：确认事务以 `BEGIN IMMEDIATE` 开始，持锁后重新核对**草稿修订号**与**最新版本号**（并确认目标版本仍在）：
   - 预览后草稿被改过 → 既有 **409 `DRAFT_REVISION_CONFLICT`**（附 `expectedRevisionNo` / `currentRevisionNo`）；
   - 预览后有人发布新版 → 既有 **409 `VERSION_CONFLICT`**（附 `expectedVersionNo` / `currentVersionNo`）；
   - 写锁等待超时（另一进程长时间占用写事务）→ 同样归为 **409 草稿冲突**，不透出底层锁错误；
   - 任一冲突都**整次不改库**（不清空、不重建、不登记恢复），客户端重新预览后用新返回的号码重试即可。
3. **成功语义不变**：200 时只复制目标版每事件**被选的一条主张**，重置草稿编号，修订号只 +1，返回旧→新 id 映射与 `pendingSelection`；成功响应里的新草稿全貌 / 修订号 / 最新版本号也取自同一事务。**历史快照与访客视图不变**；**撤回版仍可恢复**（预览响应附 `retraction`，访客最新年表仍指向最大的未撤回版）；目标版本不存在预览与确认都返回 404。

预览与确认的路径、请求头、请求体与响应字段（`versionNo` / `draftRevisionNo` / `currentVersionNo` 等）**完全保持兼容**。完整可运行示例：

```bash
node examples/concurrent-restore-example.mjs
# 可选 ROUNDS=24（持续写入下的交错预览轮数）、PORT_A/PORT_B、KEEP=1 保留现场
```

脚本同样拉起**两个共享同一 `DB_PATH` 的服务进程**，只走 HTTP API：①预览后另一进程改草稿 → 409 且整次不改库，重新预览后 200；②预览后另一进程发新版 → 409；③严格交错「A 预览 → B 写入 → A 再预览」多轮，逐轮验证预览展示的内容与返回修订号同源、预览自身不写库；④从已撤回版恢复成功而访客年表不变。

### 并行编辑会话（两人同时整理草稿：暂存 → 三方合并提交）

两名编辑者需要**同时整理同一份草稿**（不止发布时刻冲突）时，可在工作台「并行编辑会话」卡片各自**开启编辑会话**，或直接调用 HTTP API：

- **开启即快照**：开启会话时记录当时的**草稿修订号**与全部事件 / 时间主张 / 「先于」关系（**基线，只读不变**）。草稿**不加锁**，对方可继续直接编辑或开自己的会话。
- **会话内修改先暂存**：修改写成一批**操作**（`create_event` / `update_event` / `delete_event` / `create_claim` / `update_claim` / `delete_claim` / `create_relation` / `update_relation` / `delete_relation`）暂存进会话，**不直接写草稿**。新建对象用会话内**临时编号**（`tempId`）互相引用（`eventRef` / `earlierRef` / `laterRef` 等）；引用基线中的对象用其正式 id。暂存沿用现有的主张日期、出处（必填）、关系（禁止自环、端点须存在）校验，**整批校验、有问题整批拒绝**（422，逐条列出）。
- **提交时三方合并**：对照**会话基线**、**当前草稿**、**会话工作稿**（基线 + 暂存操作）逐项合并——
  - 彼此未触及的对象或字段**自动合并**（对方改标题、你改描述，两个改动都保留；对方新增 / 删除的对象原样保留），**不覆盖另一人的改动**；
  - 以下情况**整次拒绝**（409 `SESSION_MERGE_CONFLICT`），**逐项列出基线、当前值和拟提交值**供人工重编，草稿一字未动：
    1. **同一字段被双方改成不同值**（逐字段列出三方值）；
    2. **编辑与删除相撞**（你改它删 / 你删它改，含你的删除会级联丢弃对方在该事件上新增的主张或关系）；
    3. **关系端点已删除**（会话新增 / 保留的关系或主张引用了对方已删除的事件）；
    4. **恢复导致对象身份更替**（`restore_rebased`）：会话开启后任何人执行了「从历史版本恢复草稿」。恢复会清空草稿并按版本快照重建、**重排全部对象编号**——旧事件 A 的编号可能被新事件 B 占用，基线中的对象与当前草稿的同编号对象已不再是同一对象，按编号对齐的合并会把旧对象的改动写进新对象。因此跨恢复的会话提交一律整次拒绝（即使操作与恢复内容看似不冲突），冲突明细列出期间发生的全部恢复（序号、所据版本、时刻）。会话详情 / 列表以 `restoredAfterOpen` 提示该状态。
- **成功提交原子应用**：全部变更在**一个事务**内写入（草稿修订号只推进一次），返回**新草稿修订号**与**临时编号 → 正式编号映射**（事件 / 主张 / 关系），以及双方改了不同字段的自动合并清单。
- **幂等与冲突后重开**：会话提交后随即关闭（`committed` / `conflicted` 均为终态）。**重试同一提交返回首次结果，绝不重复写入**；冲突的会话不能再提交，须**基于最新草稿重开会话**（新会话的基线即包含对方的最新改动）人工重编后再提交。
- **与现有规则共存**：会话提交只是改写草稿，发布与预约发布的校验、`baseVersionNo` 版本冲突规则、出处遮盖、版本撤回等完全不变。**会话内容只在 `/api/editor` 下暴露（持编辑口令），访客不可见。**

```bash
TOKEN=editor
BASE=http://localhost:3000

# 1) 甲、乙各自开启会话（记录当时的草稿修订号与基线快照）
curl -s -X POST "$BASE/api/editor/sessions" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"editor":"甲"}'
# => 201 {"ok":true,"session":{"sessionId":1,"status":"open","baseRevisionNo":5,
#        "baseline":{"events":[...],"relations":[...],"counts":{...}},"ops":[],"working":{...}}}

# 2) 甲在会话 1 内暂存一批操作（整批校验；新对象用临时编号互相引用）
curl -s -X POST "$BASE/api/editor/sessions/1/ops" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"ops":[
        {"op":"create_event","tempId":"chou-shui-ji","title":"抽水机到站"},
        {"op":"create_claim","tempId":"c1","eventRef":"chou-shui-ji",
         "precision":"year","year":1962,"source":"张德福口述"},
        {"op":"create_relation","tempId":"r1","earlierId":2,"laterRef":"chou-shui-ji"},
        {"op":"update_event","eventId":1,"description":"只改描述这一个字段"}
      ]}'
# => 201 {"ok":true,"staged":4,"opCount":4,"working":{...会话工作稿预览...}}（草稿尚未变化）

# 3) 提交会话：三方合并，无冲突则原子应用全部变更
curl -s -X POST "$BASE/api/editor/sessions/1/commit" -H "X-Editor-Token: $TOKEN"
# => 200 {"ok":true,"alreadyCommitted":false,"revisionNo":6,
#        "idMap":{"events":[{"tempId":"chou-shui-ji","eventId":3}],
#                 "claims":[{"tempId":"c1","claimId":3,"eventId":3}],
#                 "relations":[{"tempId":"r1","relationId":2}]},
#        "applied":{"eventsCreated":1,...},"autoMerged":[...]}

# 4) 重试同一提交：幂等返回首次结果，不重复写入
curl -s -X POST "$BASE/api/editor/sessions/1/commit" -H "X-Editor-Token: $TOKEN"
# => 200 {"ok":true,"alreadyCommitted":true,"revisionNo":6,"idMap":{...同上...}}

# 5) 冲突示例：双方把同一字段改成不同值，后提交者整次拒绝
curl -s -X POST "$BASE/api/editor/sessions/2/commit" -H "X-Editor-Token: $TOKEN"
# => 409 {"code":"SESSION_MERGE_CONFLICT","currentRevisionNo":8,
#        "conflicts":[{"type":"field_conflict","objectType":"event","id":2,
#          "fields":[{"field":"title","baseline":"东干渠通水","current":"…（甲定稿）","proposed":"…（乙定稿）"}],
#          "baseline":{...},"current":{...},"proposed":{...}}]}
#    其它冲突类型：edit_delete（编辑与删除相撞）、endpoint_deleted（关系端点已删除）。
#    草稿未做任何改动；须重开会话（基线即最新草稿）人工重编后再提交。

curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/sessions"      # 会话列表
curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/sessions/1"    # 会话详情（基线/操作/工作稿/结果）
```

**会话期间发生「从历史版本恢复」时**（恢复重排对象编号，基线对象身份已更替），未关闭会话的提交一律 409，草稿不改动；须重开会话：

```bash
TOKEN=editor
BASE=http://localhost:3000

# 1) 甲开启会话（基线含事件 A，编号 1），只暂存「改 A 的描述」
SID=$(curl -s -X POST "$BASE/api/editor/sessions" -H "Content-Type: application/json" \
  -H "X-Editor-Token: $TOKEN" -d '{"editor":"甲"}' | jq .session.sessionId)
curl -s -X POST "$BASE/api/editor/sessions/$SID/ops" -H "Content-Type: application/json" \
  -H "X-Editor-Token: $TOKEN" \
  -d '{"ops":[{"op":"update_event","eventId":1,"description":"甲改的描述"}]}'

# 2) 乙删除 A、创建事件 B 并发布，再从该版恢复草稿：B 重新占用编号 1
curl -s -X DELETE -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/events/1"
B=$(curl -s -X POST "$BASE/api/editor/events" -H "Content-Type: application/json" \
  -H "X-Editor-Token: $TOKEN" -d '{"title":"事件B"}' | jq .event.id)
CB=$(curl -s -X POST "$BASE/api/editor/events/$B/claims" -H "Content-Type: application/json" \
  -H "X-Editor-Token: $TOKEN" -d '{"precision":"year","year":1958,"source":"乙的出处"}' | jq .claim.id)
curl -s -X POST "$BASE/api/editor/publish" -H "Content-Type: application/json" \
  -H "X-Editor-Token: $TOKEN" \
  -d '{"selection":[{"eventId":'"$B"',"claimId":'"$CB"'}],"baseVersionNo":0}'
PV=$(curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/restore-preview/1")
curl -s -X POST "$BASE/api/editor/restore" -H "Content-Type: application/json" \
  -H "X-Editor-Token: $TOKEN" \
  -d '{"versionNo":1,"draftRevisionNo":'"$(echo "$PV" | jq .draftRevisionNo)"',"currentVersionNo":'"$(echo "$PV" | jq .currentVersionNo)"'}'

# 3) 甲的会话详情已提示对象身份更替；提交被整次拒绝（409），B 的描述不会被改写
curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/sessions/$SID" | jq .session.restoredAfterOpen
# => true
curl -s -X POST "$BASE/api/editor/sessions/$SID/commit" -H "X-Editor-Token: $TOKEN"
# => 409 {"code":"SESSION_MERGE_CONFLICT",
#        "conflicts":[{"type":"restore_rebased",
#          "message":"会话开启后草稿被「从历史版本恢复」整体替换过 1 次（第 1 次（恢复自第 1 版，…））：…无法安全三方合并",
#          "restores":[{"restoreNo":1,"versionNo":1,"restoredAt":"…"}],
#          "baseline":null,"current":null,"proposed":null}]}
#    草稿一字未动；重复提交同样 409 且 alreadyConflicted:true（保持首次结果）。

# 4) 甲基于最新草稿重开会话（基线即恢复后的草稿，B 占用编号 1），重新暂存后提交成功
SID2=$(curl -s -X POST "$BASE/api/editor/sessions" -H "Content-Type: application/json" \
  -H "X-Editor-Token: $TOKEN" -d '{"editor":"甲"}' | jq .session.sessionId)
curl -s -X POST "$BASE/api/editor/sessions/$SID2/ops" -H "Content-Type: application/json" \
  -H "X-Editor-Token: $TOKEN" \
  -d '{"ops":[{"op":"update_event","eventId":1,"description":"甲改的描述"}]}'
curl -s -X POST "$BASE/api/editor/sessions/$SID2/commit" -H "X-Editor-Token: $TOKEN"
# => 200 {"alreadyCommitted":false,"revisionNo":…}
```

完整可运行的端到端示例见 `examples/session-example.sh`（两人并行、自动合并、三类冲突逐项明细、幂等重试、冲突后重开会话、访客不可见，约 5 秒）与 `examples/session-restore-example.sh`（本会话场景：会话期间恢复草稿导致对象身份更替，跨恢复提交 409、重开会话后成功，约 3 秒）。

### 访客（http://localhost:3000/）

只渲染**编号最大的未撤回已发布版本**：按系统确定的日期排列的时间线、每条事件所选主张的精度与出处、全部「先于」关系及其出处，以及该版各目标的**生效勘误附记**（说明与出处）。草稿、未发布主张、未发布关系均不出现在任何公开接口中。尚无发布版本时仅显示「尚未发布」；**已发布版本全部被撤回时显示「尚无可读版本」**，待编辑者发布修正版后自动恢复。

凡编辑者已按出处原文登记遮盖的位置（含勘误附记的出处），访客在最新年表与任一历史版本中都只看到 **「出处已遮盖」**（快照原文仍在库中，仅持编辑口令的接口可查看）。**已撤回的版本不出现在访客版本清单中，指定撤回版与引用它的专题路线一律按不存在处理（404），该版的勘误附记也随之不可见。**

页面下方「专题脉络路线」卡片列出编辑者已建立的专题路线：锚点事件按顺序排列，相邻锚点之间展示该版关系图中关系数最少的见证链（锚点与链上中间事件分别标注），只展示路线涉及的事件与关系，出处同样按遮盖规则显示。

## 数据与备份

- 单文件 SQLite 数据库：容器中位于 `/app/data/chronicle.db`（Docker 卷 `chronicle-data`），本机直跑位于 `./data/chronicle.db`。
- 备份：停止写入后复制该 `.db` 文件即可（或使用 SQLite 的 `.backup` 命令）。
- 历史版本表 `versions / version_events / version_relations` 只追加、不更新不删除，保证不可变。
- 导入批次表 `import_batches` 记录每次成功导入的批次标识与内容指纹，用于防止同一批次重复导入。
- 出处遮盖表 `source_redactions` 同样只追加：只存被遮盖出处的**规范文本**（提交文本 `trim` 折叠首尾空白后；UNIQUE），**不回写快照或草稿**；读出时对库存出处同样 `trim` 后与之严格相等比较（仅首尾空白不同即命中，内部空白逐字区分）；删除该表对应行即恢复公开显示。
- 版本撤回表 `version_retractions` 只追加审计记录：版本号（UNIQUE，每版至多一条）、非空原因、编辑者、时间；**不回写快照或草稿**，访客读出层据此隐藏撤回版，编辑者接口不受影响。
- 勘误附记表 `errata` 只追加：目标版号、对象类型（event / relation）、该版快照对象编号、勘误说明、出处、编辑者、被替代的前一条附记号（`replaces_errata_id`，NULL 为该目标首条）。**不回写快照或草稿**；同一目标的生效附记即链尾（id 最大者），替代时事务内核对所见附记号，冲突不落库；旧附记全部保留供追溯。公开读出时附记出处与库存值各自 `trim` 后按 `source_redactions` 规范文本动态遮盖（首尾空白折叠、内部逐字区分）；目标版撤回后访客不再看到该版及其附记。
- 预约发布表 `publish_schedules` 在建立时冻结完整待发布内容（事件 / 所选主张 / 关系 / 求解日期）与基准版本号；`status` 在待执行（`pending`）、已发布（`published`）、冲突（`conflict`）、已取消（`cancelled`）间单向流转。到期写版本与翻状态在同一事务内完成，重启只补跑 `pending` 行；**冻结基准版已被撤回的预约到期转冲突，不生成新版本**。
- 脉络路线表 `routes / route_anchors / route_segments` 同样只追加：建立时冻结所据版本号、锚点顺序与每段见证链（事件 id 序列与关系 id 序列），展示字段读自该版不可变快照，因此改草稿、恢复草稿、发新版都不影响旧路线。
- 并行编辑会话表 `edit_sessions / edit_session_ops`：开启会话时把当时的草稿修订号、恢复序号（`base_restore_no`，草稿代）与完整草稿快照写入 `baseline_json`（基线只读）；会话内的修改按操作逐条暂存于 `edit_session_ops`（不触碰草稿区，也不推进草稿修订号）。提交时三方合并的结果（新修订号与编号映射，或冲突明细）存回 `result_json`，会话随即关闭（`committed` / `conflicted` 终态），重复提交直接返回该结果、绝不重复写入。
- 草稿恢复登记表 `draft_restores` 只追加：每次「从历史版本恢复草稿」确认成功即登记一行（所据版本号、时刻）。其最大行号即「草稿代」——恢复会重排全部对象编号，开启中的并行编辑会话提交时比对草稿代，不一致即识别为对象身份更替，整次拒绝（409 `restore_rebased`），避免把旧对象的改动合并进占用同一编号的新对象。

## 目录结构

```
src/
  server.js     Express 入口、口令中间件、静态界面
  routes.js     公开只读 API 与编辑者草稿/发布/恢复 API
  db.js         SQLite 连接与建表（草稿区 + 草稿修订号触发器 + 版本快照区）
  dates.js      年/月/日精度 → 覆盖区间（公历序数日）
  solver.js     Tarjan 环检测 + 拓扑下界传播求严格先后可行解
  publish.js    发布事务：再校验 + 版本冲突检查 + 写不可变快照
  restore.js    恢复草稿：只读预览（目标版本/当前草稿/修订号/最新版本号在同一快照读出，不写库）
                + BEGIN IMMEDIATE 原子替换事务（先取写锁再做修订号/版本号冲突检查、按快照重建）；
                事务内登记 draft_restores（草稿代 +1），供并行编辑会话识别对象身份更替
  bundle.js     采访整理包导入：整包校验 + 内容指纹 + 只读预览 + 事务追加（批次防重/修订号冲突检查）
  redact.js     出处遮盖：登记文本与库存出处各自 trim 折叠首尾空白后严格相等匹配
                （仅首尾空白不同视为同一出处，内部空白逐字区分）；只读命中预览 + 只追加登记
                （版本号冲突检查）；公开读出层（版本/路线/附记）动态替换为「出处已遮盖」
  retract.js    版本撤回：按版本号 + 非空原因只追加审计记录（快照/版本号不变，重复撤回幂等返回首次记录）；公开读出层隐藏撤回版（最新年表指向最大未撤回版，撤回版详情与引用它的路线按不存在处理）
  errata.js     勘误附记：对指定已发布版本中的事件 / 「先于」关系登记附记（只追加，不改快照/草稿）；
                替代须提交所见附记号（事务内核对，两人同时替代仅一个成功，冲突方取得当前附记且不落库）；
                同一目标只展示最新生效附记，旧附记以替代链保留供追溯；公开读出层按 trim 折叠规则遮盖附记出处，
                目标版撤回后访客不可见
  schedule.js   预约发布：建立时冻结快照/基准版本号；到期按时间、预约号顺序逐条事务执行（发布或标冲突，幂等不重发不留半版；基准版已撤回 → 冲突）；查看/取消
  scheduler.js  预约调度器：每秒检查到期预约，服务启动立即补跑（重启安全）
  route.js      专题脉络路线：锚点校验 + 线性时间见证链求解（正/反向 BFS 定层 + 逐层最小关系 ID 贪心
                + 父指针回溯；每段关系数最少、同长度按关系 ID 序列择小，长链不逐层复制路径）
                + 冻结落库；公开读出层动态遮盖出处
  session.js    并行编辑会话：开启时快照基线（草稿修订号 + 恢复序号 + 事件/主张/关系）；操作暂存（整批校验）；
                提交时三方合并（基线/当前草稿/会话工作稿）——未触及的对象与字段自动合并，
                同字段双改/编辑删除相撞/关系端点已删除整次拒绝并逐项列出三方值；
                会话开启后草稿被恢复替换过（草稿代已变）同样整次拒绝（restore_rebased），
                不把旧对象的改动合并进占用同一编号的新对象；
                成功提交事务内原子应用（修订号只推进一次）并返回临时编号映射，重复提交幂等
  seed.js       演示数据
public/         访客页与编辑台（原生 HTML/CSS/JS）
examples/       采访整理包 JSON 示例；出处遮盖、预约发布、脉络路线（含两万事件长链路线）、版本撤回、勘误附记、并行编辑会话（含跨恢复冲突）curl 调用示例；concurrent-publish-example.mjs 拉起两个共用同一库的服务进程演示发布/预约的版本冲突与草稿冲突；concurrent-restore-example.mjs 演示恢复预览四值同源（持续写入下逐轮预览内容与修订号一致）、确认 409 两类冲突与重试、从撤回版恢复而访客视图不变
test/           node:test 单元与端到端测试（含成环、无解、409 冲突、草稿恢复、整理包导入、出处遮盖、预约发布/重启补跑、脉络路线（含两万事件长链路线与随机图新旧求解对照）、版本撤回、勘误附记替代与并发冲突、并行编辑会话三方合并与跨恢复对象身份更替、双连接/多线程发布与预约的草稿快照一致性与草稿冲突、恢复预览同一快照四值同源与确认 409/写锁冲突）
```

## 主要 HTTP API

公开（无口令）：

> 出处遮盖统一按「两侧各自 `trim` 折叠首尾空白后严格相等」判定（事件主张、先于关系、专题路线、勘误附记皆然）：仅首尾空白不同视为同一出处，内部空白与其他文字逐字区分。

- `GET /api/public/chronicle` — 编号最大的**未撤回**已发布版本完整快照（命中遮盖登记的 `source` 显示「出处已遮盖」；`version.errata` 为该版各目标的生效勘误附记，附记出处同样应用遮盖；全部撤回时 `{published:false, allRetracted:true, message:"尚无可读版本…"}`）
- `GET /api/public/versions` / `GET /api/public/versions/:no` — 版本清单 / 指定版本（**均不含撤回版**；指定撤回版按不存在处理 404，其勘误附记随之不可见；未撤回版同样应用遮盖并附 `version.errata`，结构不变）
- `GET /api/public/routes` / `GET /api/public/routes/:no` — 脉络路线清单 / 路线详情（只含路线涉及的事件与关系，锚点与中间事件以 `role` 区分，出处同样应用遮盖；**引用撤回版的路线隐藏 / 404**）

编辑（需请求头 `X-Editor-Token`）：

- `GET  /api/editor/state` — 草稿全貌 + 当前版本号（最高已发布版本号，含撤回版）+ 访客可见最新版号 `latestVisibleVersionNo` + 草稿修订号 `draftRevisionNo`
- 事件：`POST /api/editor/events`、`PUT/DELETE /api/editor/events/:id`
- 主张：`POST /api/editor/events/:id/claims`、`PUT/DELETE /api/editor/claims/:claimId`
- 关系：`POST /api/editor/relations`、`DELETE /api/editor/relations/:id`
- `POST /api/editor/validate` — 预校验（不落库）
- `POST /api/editor/publish` — 发布；体含 `selection:[{eventId,claimId}]`、`baseVersionNo`、`editor`、`note`
  - 422：`{errors:[{type:missing|cycle|temporal, eventIds, relationIds, message, detail}]}`
  - 409：`{code:"VERSION_CONFLICT", baseVersionNo, currentVersionNo, currentVersion}`
  - 409（多进程共用库并发）：`{code:"DRAFT_REVISION_CONFLICT", expectedRevisionNo, currentRevisionNo, message}`（读草稿与写事务之间草稿被另一进程改动；整次不生成版本，刷新草稿重新确认选择后重试）
- `GET  /api/editor/restore-preview/:no` — 从第 `:no` 版恢复草稿的只读预览（该版被选内容 + 将被替换的当前草稿）；**目标版本、当前草稿（全部事件 / 主张 / 关系）、`draftRevisionNo`、`currentVersionNo` 在同一数据库快照内读出（四值同源），预览不写库**；版本不存在 404；撤回版同样可预览（响应附 `retraction`）
- `POST /api/editor/restore` — 确认恢复（BEGIN IMMEDIATE 写事务，先取写锁再校验）；体含 `versionNo`、`draftRevisionNo`、`currentVersionNo`（后两者取预览返回值，字段与预览完全一致）
  - 200：`{restoredFromVersionNo, currentVersionNo, revisionNo, idMap:{events,relations}, pendingSelection:[{eventId,claimId}], draft}`（仅复制目标版每事件被选的一条主张；历史快照与访客视图不变）
  - 409：`{code:"DRAFT_REVISION_CONFLICT"|"VERSION_CONFLICT", ...}`（预览后草稿或最新版本变化，或确认时等不到另一进程持有的写锁；整次不改库，重新预览后重试）；目标版本不存在 404；参数非法 400
- `POST /api/editor/import-preview` — 整理包只读预览；请求体即整理包 JSON，返回 `fingerprint`、`draftRevisionNo`、`counts`、待写入 `events`/`relations` 与 `alreadyImported` 提示
  - 422：`{code:"BUNDLE_INVALID", problems:[{type, message, ...}]}`（键重复 `duplicate_key`、引用缺失 `missing_reference`、日期非法 `invalid_date`、出处非法 `invalid_source`、自环 `self_relation`、结构非法 `invalid_structure`，整包拒绝）
- `POST /api/editor/import` — 确认导入；体含 `bundle`（原包）、`fingerprint`、`draftRevisionNo`（后两者取预览返回值）
  - 201：`{batchId, revisionNo, counts, idMap:{events:[{key,eventId,claimIds}], relations:[{earlierKey,laterKey,relationId}]}}`（一个事务追加整包）
  - 409：`{code:"BUNDLE_CONTENT_MISMATCH"|"DRAFT_REVISION_CONFLICT"|"BATCH_ALREADY_IMPORTED", ...}`（内容被替换 / 草稿已变化 / 批次已导入，均不写入）；参数非法 400
- `POST /api/editor/redaction-preview` — 出处遮盖只读预览；体含非空 `source`（返回其 `trim` 折叠首尾空白后的规范文本；命中规则：两侧各自 trim 后严格相等，内部空白与其他文字逐字区分），返回全部已发布版本的命中位置/数量（每条命中附库存原文 `source`）、`currentVersionNo` 与草稿区参考计数
  - 200：`{source, alreadyRedacted, currentVersionNo, versionCount, totalEventHitCount, totalRelationHitCount, totalHitCount, versions:[{versionNo,eventHitCount,relationHitCount,eventHits:[{eventId,title,sortOrder,source}],relationHits:[{relationId,earlierEventId,laterEventId,sortOrder,source}]}], draft:{claimHitCount,relationHitCount,claimHits:[{...,source}],relationHits:[{...,source}],...}}`
  - 400：空 / 纯空白 / 非字符串文本
- `POST /api/editor/redaction` — 确认遮盖（只追加登记，不改写快照或草稿）；体含 `source`、`currentVersionNo`（取预览返回值）、可选 `editor`
  - 200：`{alreadyRedacted:false, redactedLabel:"出处已遮盖", redactedAt, ...命中统计}`；重复确认 200 且 `alreadyRedacted:true`（不重复登记）
  - 409：`{code:"VERSION_CONFLICT", currentVersionNo, expectedVersionNo, ...}`（预览后发布了新版本，不落库）；空文本或版本号非法 400
- `GET  /api/editor/redactions` — 已登记遮盖清单（编辑者视角，含出处原文与登记时间）
- `POST /api/editor/schedules` — 建立预约发布；体含 `selection:[{eventId,claimId}]`、`scheduledAt`（未来 UTC，如 `2026-10-02T12:34:00Z`）、`baseVersionNo`、`editor`、`note`
  - 201：`{schedule:{scheduleNo, scheduledAt, status:"pending", baseVersionNo, draftRevisionNo, eventCount, relationCount, frozen:{events:[…含 resolvedDate/source…], relations:[…]}, ...}}`（冻结快照）
  - 400：时间非法 / 非未来时刻（`{code:"INVALID_SCHEDULED_TIME"}`）或选择为空；422：草稿未通过现有发布校验（`{errors:[...]}`，同即时发布）；409：`VERSION_CONFLICT`（基准版本号已过期）或 `DRAFT_REVISION_CONFLICT`（读草稿与写事务之间草稿被另一进程改动，附 `expectedRevisionNo`/`currentRevisionNo`）；均不建立预约
- `GET  /api/editor/schedules` — 预约列表（待执行在前、按到期时刻升序；列表项含冻结事件摘要与执行结果）
- `GET  /api/editor/schedules/:no` — 预约详情（展开冻结的完整事件 / 主张 / 关系 / 求解日期；不存在 404）
- `DELETE /api/editor/schedules/:no` — 取消尚未执行的预约（200 `{cancelled:true}`；重复取消已取消的预约幂等 200 且 `alreadyCancelled:true`）
  - 409：`{code:"SCHEDULE_NOT_CANCELLABLE", statusNow:"published"|"conflict", resultVersionNo}`（已生效不能取消）；不存在 404
- `GET  /api/editor/versions/:no/raw` — 指定版本快照**原文**（持编辑口令，不应用遮盖；撤回版同样可见，响应附 `retraction`，未撤回为 `null`；恢复草稿亦用原文）。`version.errata` 附该版各目标的生效勘误附记（原文，不遮盖）
- `POST /api/editor/errata` — 登记 / 替代勘误附记（只追加，不改快照/草稿）；体含 `versionNo`、`targetType`（`event`/`relation`）、`targetId`（该版快照对象编号）、`note`（勘误说明）、`source`（出处）、`editor`、替代时另含 `replacesErrataId`（所见生效附记号）
  - 201：`{ok, errata:{errataId, versionNo, targetType, targetId, note, source, editor, replacesErrataId, createdAt}, replaced}`（`replaced` 为被替代的前一条生效附记，首条为 `null`）
  - 404：版本不存在；422：`{code:"ERRATA_TARGET_NOT_IN_VERSION"}`（对象不属该版）；409：`{code:"VERSION_RETRACTED"}`（目标版已撤回）或 `{code:"ERRATA_CONFLICT", current}`（所见附记号与当前生效附记不一致，返回当前生效附记，**不落库**——两人同时替代仅一个成功）；400：字段非法；均不落库
- `GET  /api/editor/versions/:no/errata` — 指定版本的全部勘误附记（编辑者视角，原文不遮盖）：按目标分组，每组含目标信息、`effective`（当前生效附记）与 `chain`（完整替代链，旧→新）；响应附 `retraction`；版本不存在 404
- `GET  /api/editor/errata/:id` — 单条附记 + 其所在目标的完整替代链（编辑者追溯用，原文不遮盖）；响应附 `retraction`；不存在 404
- `POST /api/editor/versions/:no/retract` — 撤回指定已发布版本（只追加审计记录，快照与版本号不变）；体含 `reason`（非空撤回原因，≤1000 字）、`editor`
  - 200：`{ok, alreadyRetracted:false, retraction:{versionNo,reason,editor,retractedAt}, currentVersionNo, latestVisibleVersionNo}`；**重复撤回幂等**：200 且 `alreadyRetracted:true`，返回首次记录、不覆盖原因
  - 404：版本不存在；400：版本号非法或原因为空 / 纯空白 / 非字符串 / 超长；均不改状态
- `GET  /api/editor/retractions` — 已撤回版本清单（编辑者视角，含原因与撤回时间；附 `currentVersionNo` 与 `latestVisibleVersionNo`）
- `GET  /api/editor/versions` — 版本清单（每项附 `retracted` 与 `retraction`；`currentVersionNo` 仍为最高已发布版本号，发布/预约基准不变）
- `POST /api/editor/routes` — 建立专题脉络路线；体含 `title`（专题标题）、`versionNo`（所据已发布版本）、`anchorEventIds`（≥2 个互异事件 id，按路线顺序）、`editor`、`note`
  - 201：`{route:{routeNo, title, versionNo, anchors:[{position,eventId,title}], segments:[{position,fromEventId,toEventId,eventIds,relationIds}], events:[{eventId,role:"anchor"|"intermediate",anchorPosition,...}], relations:[...]}}`（冻结落库，不可变）
  - 400：标题为空 / 锚点不足两个 / 事件 id 非整数 / 重复事件（`ROUTE_DUPLICATE_EVENTS`）；404：版本不存在；422：`{code:"ROUTE_INVALID", errors:[{type:"unknown_event"|"disconnected", segmentIndex, eventIds, message}]}`（未知事件或断点一次性列出）；均不保存
- `GET  /api/editor/routes` — 路线清单（含锚点数 / 段数 / 所据版本；每项附 `versionRetracted` 标记所据版本已撤回）
- `GET  /api/editor/routes/:no/raw` — 路线详情**原文**（持编辑口令，不应用遮盖；引用撤回版的路线仍可见，响应附 `versionRetracted`）；不存在 404
- `POST /api/editor/sessions` — 开启并行编辑会话；体含 `editor`、`note`。记录当时**草稿修订号**、**恢复序号**（草稿代）与事件 / 主张 / 关系快照（基线，只读）
  - 201：`{session:{sessionId, status:"open", baseRevisionNo, baseRestoreNo, currentRevisionNo, restoredAfterOpen, openedAt, baseline:{events,relations,counts}, ops:[], working, result:null}}`
- `GET  /api/editor/sessions` — 会话列表（状态 / 基线修订号 / 暂存操作数 / 提交结果摘要；附当前 `draftRevisionNo`；每项附 `restoredAfterOpen` 标记开启后草稿是否被恢复替换过）
- `GET  /api/editor/sessions/:id` — 会话详情：基线快照、暂存操作列表、会话工作稿（基线 + 操作折叠）、提交结果；附 `restoredAfterOpen`；不存在 404
- `POST /api/editor/sessions/:id/ops` — 暂存一批操作；体含 `ops:[...]`（`create_event`/`update_event`/`delete_event`/`create_claim`/`update_claim`/`delete_claim`/`create_relation`/`update_relation`/`delete_relation`；新对象以 `tempId` 标记并用 `eventRef`/`earlierRef`/`laterRef`/`claimRef` 等引用，基线对象用正式 id）
  - 201：`{staged, opCount, working}`（工作稿预览；草稿尚未变化，修订号不推进）
  - 422：`{code:"SESSION_OPS_INVALID", problems:[{opIndex, message}]}`（日期 / 出处 / 关系校验与现有录入一致，整批拒绝不落半截）；ops 非数组或为空 400；会话已关闭 409 `SESSION_NOT_OPEN`
- `POST /api/editor/sessions/:id/commit` — 提交会话：三方合并（基线 / 当前草稿 / 会话工作稿）
  - 200：`{alreadyCommitted:false, revisionNo, idMap:{events:[{tempId,eventId}],claims:[{tempId,claimId,eventId}],relations:[{tempId,relationId}]}, applied:{...}, autoMerged:[{objectType,id,sessionFields,otherFields}]}`（一个事务原子应用，修订号只推进一次）；**重复提交幂等**：200 且 `alreadyCommitted:true`，返回首次结果、不重复写入
  - 409：`{code:"SESSION_MERGE_CONFLICT", currentRevisionNo, conflicts:[{type:"field_conflict"|"edit_delete"|"endpoint_deleted"|"restore_rebased", objectType, id/tempId, message, fields?:[{field,baseline,current,proposed}], baseline, current, proposed}]}`（整次拒绝、逐项列出三方值，草稿未动；重复提交同样 409 且 `alreadyConflicted:true`）；`restore_rebased` 表示会话开启后草稿被「从历史版本恢复」整体替换过、对象身份已更替（该条附 `restores` 恢复明细，无三方值）；冲突后须重开会话
