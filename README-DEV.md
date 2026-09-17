# dsh-archive-manager 本地增强补丁（收藏 / 复制会话 ID 与文件路径）

目标插件：`@michengai/dsh-archive-manager@0.1.40`（DSH Desktop profile）
安装路径：`~/.dsh/profiles/desktop/node_modules/@michengai/dsh-archive-manager`

---

## 一、本次改动

### 1. 归档会话页（设置 → 归档会话），`lib/client.js`

| 功能 | 说明 |
|---|---|
| 星标收藏 | 每条归档聊天左侧新增星标按钮，点击收藏/取消收藏；`localStorage`（键 `dsham.favoriteArchivedSessions.v1`）持久化 |
| 只看收藏 | 工具栏新增开关，一键过滤出已收藏的归档聊天；旁边显示「已收藏 n 条」 |
| 收藏置顶 | 列表内已收藏的聊天自动排在同组最前（不改变其他排序规则） |
| 删除全部未收藏 | 页面头部新增按钮，删除「全部归档中未收藏的聊天」（已收藏的一律保留） |
| 删除当前筛选未收藏 | 工具栏新增按钮，只作用于当前项目筛选/搜索结果的未收藏聊天 |
| 删除确认 | 复用原有确认弹窗；未收藏场景有独立标题/说明/确认按钮文案，并显示待删条数 |
| 收藏清理 | 单条或批量删除成功后，自动从收藏集合中移除已删除的会话 id |

### 2. 侧栏会话行「…」展开菜单，`lib/client.js`

菜单项（在原有 重命名/分叉/归档/删除 之前插入）：

- **收藏 / 取消收藏**（与归档页共享同一份状态，任一处操作另一处实时同步）
- **复制会话 ID**
- **复制会话文件路径**（该会话转录工件的绝对路径，如 `...\<sessionId>.jsonl`）
- **复制 ID + 文件路径**（一键复制两行文本）

复制结果会短暂显示在会话行的时间位置（如「已复制 ID」「已复制路径」「未找到会话文件路径」）。

### 3. 宿主端：新增只读路由，`lib/index.js` + `lib/session-path.js`（新文件）

```
GET /api/michengai/dsh-archive-manager/session-path?sessionId=<id>
→ { sessionId, cwd, path, kind }
```

- 解析顺序：`sessionPersistence.stat(id)` → `header` → `persistence.locate(header)`；
  未命中时回退到运行中会话的 `sessions.list()` 内存 header。
- 安全：仅本机回环来源（`127.0.0.0/8`、`::1`、`localhost`）放行，并校验 `sec-fetch-site`；只读、不写盘。
- `lib/index.js` 的 `apply()` 现在同时注册「检查更新路由」和「会话路径路由」，返回组合 disposer。

---

## 二、应用 / 回滚 / 重放

### 应用（幂等校验）
```powershell
cd <你的插件目录>\dsh-archive-manager-favorites-patch
node apply-patch.mjs --dry-run   # 只校验 24 处锚点是否唯一命中，不写盘
node apply-patch.mjs             # 正式应用（自动备份到 ~/.dsh/backups/archive-manager-client-<时间戳>/）
```

### 回滚
```powershell
node apply-patch.mjs --revert    # 还原 client.js 到最近一次自动备份
```
宿主端回滚：从 `~/.dsh/backups/archive-manager-favorites-20260914-161730/` 拷回 `lib-index.js.orig` 覆盖 `lib/index.js`，并删除 `lib/session-path.js`。

### 回归验证
```powershell
node probe-favorites.mjs     # 43 项：模块加载 / 收藏纯函数 / store / 菜单项 / apply 注册
node probe-host-route.mjs    # 22 项：路由注册 / 参数校验 / 同源防护 / 解析与回退 / 错误码
```

### 生效条件
客户端 bundle 与宿主路由都在 DSH 启动时加载 → **必须重启 DSH 才生效**（改磁盘后热更新无效）。

---

## 三、上游更新后会怎样（重要）

上游 `MichengAI/dsh-archive-manager` 维护非常活跃（0.1.41 于 2026-09-14 发布），一旦执行更新
（界面上的更新按钮，或 `dsh plugin add @michengai/dsh-archive-manager`）：

1. npm/pnpm 会用新版本**完整重建插件目录**；
2. `lib/client.js`、`lib/index.js` 被官方版本覆盖 → 上述全部功能消失；
3. 新增的 `lib/session-path.js` 不在上游包内，同样被清除。

**恢复步骤**：更新完成后重新执行
```powershell
node apply-patch.mjs
# 若报 [FAIL] 锚点失配（上游改动了对应代码区域），脚本不会写坏文件，
# 需要先按新版源码重新对齐锚点，再执行。
```
然后重启 DSH。

宿主端文件（`session-path.js` + `index.js` 改动）需一并重新落位：把本目录的 `session-path.js`
拷到插件 `lib/` 下，并重新应用 `index.js` 的两行改动（import + 注册）。

---

## 四、如果要发布到自己的 GitHub / npm

上游许可为 **Apache-2.0**，允许修改与再分发，但必须：

1. 保留上游 `LICENSE` 与版权声明；对修改过的文件注明「已修改」；
2. 说明这是 `MichengAI/dsh-archive-manager` 的修改版（fork），不得暗示官方背书；
3. **不能用 `@michengai/*` 这个 npm scope**（属于原作者），要换成自己的 scope 或非 scope 包名；
4. 改包名时必须**同步改全**这几处，否则插件加载或 remote 调用会失败：
   - `package.json` → `name`
   - `cordis.patch.yml` → `insert[].id` 与 `insert[].name`
   - `lib/client.js` → `window.__ModuleLoader__.load({ id: "..." })`
   - `lib/client.js` → `ARCHIVE_MANAGER_REMOTE.package` 与各 descriptor 的 `id` / `typeSymbol`
5. 本插件会替换宿主 `workspace` 服务并占用 `settings.section id = archived-sessions` 与
   `sidebar.workspaces` 插槽 → **不能与原版同时安装**，必须卸载原版后再装自维护版本。

更省心的替代路线：把本补丁改成源码级改动，向上游提 PR；合并后直接跟随官方版本升级，无需维护 fork。

---

## 五、更新记录

### 第二批：归档页「按对话轮次排序」（2026-09-14）

- 归档页排序下拉新增 **「对话轮次」**：按会话的 turn 数降序（组间按组内最大轮次）；
  数据可用时列表行 meta 显示「· n 轮」，统计中/失败在工具栏内联提示。
- 轮次口径与官方 `sessionStats` 投影一致：**`step/end` 事件的 turn 去重计数**
  （会话转录为 `<sessionId>\session.jsonl.zstd`，必须经持久化 API 解压读取，不能直接扫文件）。
- 宿主端新增只读路由 `GET /api/michengai/dsh-archive-manager/archived-turn-counts`
  （`lib/turn-counts.js`，仅本机回环可访问，并发上限 4）：
  - 客户端传 `?sessionIds=a,b,c` 优先，未传则回退宿主注册表的归档集合；
  - 结果缓存于内存与 `~/.dsh/data/dsh-archive-manager-fav/turn-counts.json`，
    以持久化 revision / sizeBytes 判断失效；写盘失败不影响返回。
- 按需加载：只有把排序切换为「对话轮次」时才请求统计，不影响默认排序体验。

### 第三批：侧栏「置顶会话」（2026-09-14）

- 侧栏会话行「…」菜单新增 **置顶会话 / 取消置顶**（localStorage 键 `dsham.pinnedSessions.v1`，与收藏相互独立）；
- 置顶会话在其所在**分组内始终排最前**，分组视图（`buildGroup` → `deriveGroups`）与单列表视图
  （`reconcileSessionOrder` 之后的最终行）都生效，即不受「手动排序 / 最近更新」覆盖；
- 置顶会话标题前显示图钉标记；取消置顶后回到原有排序位置（**不写入**侧栏的手动排序账本）；
- 只影响显示顺序，不改动宿主记账、会话数据或归档状态。

### 第四/五批：一句话 todo 摘要 —— **已于 2026-09-15 按用户要求取消**

> 结论：该功能试用后被判定"没什么用"，**展示部分已全部移除**（行内摘要、`对话摘要` 按钮、展开详情、相关 CSS 与组件）。
> 第四批 `apply-digest-patch.mjs` **仍保留**：它是**轮次排序**的数据来源（`turnCount` 与列表里的「n 轮」显示）。
> 第五批 `apply-digest-view-patch.mjs`、第七批 `apply-digest-detail-patch.mjs` 已从 `apply-all.mjs` 摘除，
> 脚本留在目录里备查（需要时可单独执行恢复）。
> 宿主端 `summarizeTodos` 也已回退：不再返回 `items`，只保留统计字段。

历史实现（保留记录，便于日后判断是否值得重启该功能）：

- **零模型调用（零 token 消耗）**，两条数据路径：
  1. 活跃会话：直接读客户端已有的 `session.projectionValues.todos`（官方 `todo_write` 投影），即时、零请求；
  2. 历史/归档会话：宿主端只读路由 `GET /api/michengai/dsh-archive-manager/session-digest`
     —— 与轮次统计同一实现，**一次读取同时得出轮次数与最后一次 `todo/write` 摘要**，按持久化 revision 缓存；
- 客户端把结果缓存进 localStorage（`dsham.sessionDigests.v1`）；归档页打开时按归档集合批量加载一次；
- 摘要口径：优先第一个 `in_progress`，其次第一个 `pending`，全部完成时回退最后一项；任务名截断 26 字；
- 缓存条目带代际版本号（v3）。

演进记录（避免重复踩坑，共五轮反馈）：
- 首版在**侧栏**会话行小字渲染 → 挤占对话清单，撤销；
- 第二版在归档行**时间后**渲染 → 同样影响清单可读性，撤销；
- 第三版做页头「任务摘要」按钮 + 汇总弹窗 → "这样显示没有作用"，撤销；
- 第四版在「查看对话」与「恢复并打开」之间显示整句摘要 → 太长，改为下一版；
- 第五版「对话摘要」按钮 + 点击展开完整清单 → **用户最终判定"没啥用"，整个功能取消**。

### 第六批：归档设置界面排版重整（2026-09-15）

用户反馈"太乱、可读性太低、太拥挤"。**只改 CSS，不动 JSX**（风险最低）：

| 改动 | 之前 | 之后 |
|---|---|---|
| 列表行 | 单行 flex：选择框+星标+标题+时间+摘要+4~5 个按钮全挤一行，标题被压扁 | **两行布局**：第一行＝选择框+星标+标题+时间；第二行＝摘要（左对齐）+操作按钮（右对齐） |
| 工具栏 | 一行塞 7 个控件（搜索/只看收藏/计数/排序/项目筛选/删除未收藏/状态） | **卡片化**，搜索框独占一行，其余筛选控件换行排列 |
| 头部操作区 | 3 个批量按钮直接贴标题，无分组 | **卡片化**（浅底＋描边＋圆角），与内容区分 |
| 选择栏 | 裸条 | 卡片化，间距统一 |
| 列表收口 | 每行都有下划线 | 最后一行去下划线；行 hover 高亮；行内间距 8px |

对应脚本：`apply-layout-patch.mjs`（1 处 CSS 追加）。

### 命令升级

首次应用、上游更新后重放，统一用一键脚本（先恢复原始 0.1.40，再依次应用**五批 52 处**补丁）：

```powershell
node apply-all.mjs
```

分步执行（等价）：

```powershell
node apply-patch.mjs         # 第一批 24 处：收藏 / 只看收藏 / 删除未收藏 / 侧栏菜单（收藏 + 复制 ID/路径）
node apply-turns-patch.mjs   # 第二批 10 处：按对话轮次排序
node apply-pin-patch.mjs     # 第三批 14 处：置顶会话
node apply-digest-patch.mjs  # 第四批  9 处：轮次数据层（宿主 turnCount 路由 + 客户端缓存）
node apply-layout-patch.mjs  # 第六批  1 处：设置界面排版重整（两行布局 + 分区卡片化）
node apply-hide-upstream-links-patch.mjs  # 第八批 3 处：隐藏 GitHub / 问题反馈 / 检查更新
node apply-delete-progress-patch.mjs      # 第九批 12 处：批量删除提速 + 进度百分比（含 workspace.js）
node apply-idle-auto-archive-patch.mjs    # 第十批 11 处：按时间筛选自动归档（天数可设）+ 撤回上一步
```

已停用的脚本（保留备查，不参与 `apply-all`）：

```powershell
# node apply-digest-view-patch.mjs   # 第五批：行内一句话摘要（已取消）
# node apply-digest-detail-patch.mjs # 第七批：「对话摘要」按钮 + 展开详情（已取消）
```

### 第八批：隐藏 GitHub / 问题反馈 / 检查更新（2026-09-16）

用户要求"这三个删掉，不用显示这些"。三处删除渲染（不是改文案）：

| 补丁 | 位置 | 做法 |
|---|---|---|
| H1 | 归档页头部 `.dsham_settingsLinks` 整块 | 区间删除（含 GitHub 与问题反馈两个 `<a>`），标题 `h2` 保留；一并吃掉前置 `", "` 避免数组留空槽 |
| H2 | `ctx.effect(() => observePluginUpdate({...}))` | 整段移除 → 「检查更新」按钮不再注入，也不再发更新检查请求 |
| H3 | CSS 末尾 | 追加 `.dsham_settingsLinks{display:none!important}` 兜底 |

验证要点（区间删除必须读回核对，语法通过不代表结构完整）：
- `t("archives.viewProject")` / `t("archives.feedback")` / links div 渲染引用 **均为 0**；
- 标题行回读为 `children: [(0, jsx)("h2", ...)]` —— 数组合法、无悬挂逗号；
- 字典里的 `"archives.viewProject"` 等条目保留（无害，不影响显示）。

### 回归验证（共 179 项断言）

| 探针 | 覆盖 | 断言数 |
|---|---|---|
| `probe-favorites.mjs` | bundle 加载 / 收藏·置顶·摘要纯函数 / 共享 store / 菜单项 / 轮次排序 / 投影透传 / apply 注册 | 91 |
| `probe-host-route.mjs` | 会话路径路由：注册 / 参数 / 同源防护 / 解析回退 / 错误码 | 22 |
| `probe-host-turn-counts.mjs` | 插件入口加载 / 轮次口径 / todo 统计 / 摘要已不含 items / 双端点 / 缓存代际 / 错误码 | 44 |
| `probe-delete-batch.mjs` | 批量删除提速与进度：三笔开销合并 / 限并发 / 结果分类互斥 / 级联复用清单 / 运行时行为 | 7 |
| `probe-idle-auto-archive.mjs` | 按时间归档：闲置筛选边界 / 非法阈值防护 / 天数持久化夹取 / 宿主批量归档运行时 / 接线与词条 | 15 |

### 第十批：按时间筛选自动归档（2026-09-16）

用户诉求："根据时间归档，超过 1 天没对话的归档；把这个按时间筛选归档写到设置中去，时间可以设置。"

**背景**：此前一次误点「全部恢复」把 `archivedSessionIds` 从 281 条清成 0。诊断脚本（`diagnose-workspace-state.mjs` / `plan-workspace-restore.mjs`）核实到备份里那 281 条会话的转录目录在磁盘上已全盘搜索零命中 —— 写回只会产生打不开的空条目，因此经用户确认改为**放弃回写旧数据、改做按时间自动归档**。

> ⚠️ 踩坑：第一版比对得出"交集 0"其实是**我算错了** —— `workspace.json` 里的会话 id 自带 `session-` 前缀，而 `~/.dsh/sessions/<cwd>/` 下的目录名是裸 uuid，必须统一口径后再比对。修正后结论才成立。

**宿主端 `lib/workspace.js`** —— 原版只有 `archiveWorkspaceSessions(workspaceId)`（整工作区全归档），无法只归档一个子集，故新增远程方法 **`archiveSessionsByIds(sessionIds)`**：

- 入参去重、过滤空值；已归档项归入 `skippedSessionIds`；未知会话归入 `failures` 且**不中断整批**
- 归档标记一次追加、**单次 `setState` 落盘**（与第九批删除提速同思路）
- 配套补齐 remote 声明条目、参数/返回 schema（`stringArraySchema` / `archiveBatchResultSchema`）与 `markRemoteMethod` 注册

**客户端 `lib/client.js`** —— 归档设置页工具栏上方新增卡片「按时间筛选归档」：

| 元素 | 行为 |
|---|---|
| 天数输入框 | `type=number`，范围 0.5 ~ 3650、步进 0.5，默认 **1 天**；改动即写入 localStorage（`dsham.idleArchiveDays.v1`），重启保留 |
| 实时预览 | 「当前有 X 个会话闲置超过 N 天」/「没有闲置超过 N 天的未归档会话」，随输入即时变化 |
| 归档这些会话 (X) | 调用新宿主接口批量归档，完成后刷新会话列表 |
| **撤回上一步** | 归档成功后才出现，一键把刚才那批恢复回未归档（复用既有 `unarchiveSessions`）；执行中禁用按钮防重复提交 |

判定依据为宿主权威的 `sessions.byId[...].updatedAt`（最后对话时间）。**安全设计**：时间戳缺失、为 0、负数或非数字的会话一律不纳入；阈值 ≤ 0 或非法时直接返回空集 —— 否则 `threshold === now` 会把所有会话判为闲置造成全量误归档（这个缺陷正是探针逼出来的，已修并有断言守护）。

**验证**：`probe-idle-auto-archive.mjs` 15 项断言，其中 4 项以类原型方法直接驱动真实 `archiveSessionsByIds`，实测去重/跳过/单次落盘/失败分类均正确；纯函数部分通过从 bundle 中提取源码（逐字符配对大括号）后用 `new Function` 实跑，覆盖阈值边界、非法输入、排序与持久化夹取。

### 第九批：批量删除提速 + 真实进度（2026-09-16）

用户反馈两点：**删除要更快**；点「删除未收藏的归档聊天」后只有"正在删除已归档聊天…"，**看不到进度和百分比**。

**速度（宿主端 `lib/workspace.js`）** —— 原版 `deleteArchivedSessions` 完全串行，每个会话都要付三笔固定开销：

| 开销 | 原版 | 本补丁 |
|---|---|---|
| `projCache.whenIdle()` | 每会话等一次 | **整批一次** |
| `listStoredHeaders()`（级联子代理用） | 每父会话全量扫盘 | **整批枚举一次**（局部闭包共享） |
| `setState()` 全量写 state 文件并广播 | 每会话一次 | **收尾合并为一次** |

实现：拆出 `deleteSessionHeavy`（重 IO：flush / 投影行删除 / spill / 转录目录 rm）以**限并发 3** 并行执行；`finishSessionDeletion`（工作区记账、索引遗忘、删除通知）与归档标记落盘留在串行收尾，避免跨会话竞态。并发度取 3 而非更高，因为 `sessions.flush` 与冷会话移除通知涉及宿主共享状态。单会话删除路径 `deleteSession` 行为完全不变。

**进度（客户端 `lib/client.js`）** —— 批量目标在客户端拆成每批 8 个会话，逐批调用宿主的 `{scope:"sessions", sessionIds}` 接口，每批返回即刷新：

- 确认弹窗内出现红色进度条 + 「正在删除：{done}/{total}（{percent}%）」（`role="status" aria-live="polite"`）
- 确认按钮在删除中变为「删除中 {percent}%」并禁用重复点击
- 页面 notice 同步显示进度，结束后显示「已删除 n 个归档会话」，部分失败显示失败数与首个原因
- 三个入口（头部全部未收藏 / 工具栏筛选内未收藏 / 删除选中）都补传 `sessionIds` 作为进度分母；拿不到显式清单时自动退回原版一次性批量接口

**验证**：`probe-delete-batch.mjs` 两项运行时用例直接以类原型方法驱动真实 `deleteArchivedSessions`（绕开 Cordis 容器构造），实测 3 个会话时 `whenIdle / listStoredHeaders / setState` 均为 **1 次**（原版各 3 次），并断言三类结果字段互斥、失败项带原因、只有成功删除的会话才进入收尾记账。

踩坑记录（均由校验抓出，非推测）：
- 工厂函数最初被插到 class 内部 → `SyntaxError: Unexpected identifier 'createBatchDeletionContext'`；改为方法内局部闭包解决。
- 注释里的反引号落在模板字符串内部，提前终止字面量 → 补丁脚本自身语法崩；改用无引号表述。
- 若漏调 `batch.warm()`，级联删子代理会静默失效（子会话残留）——已在补丁内强制前置，并加静态断言守护顺序。
- `apply-all.mjs` 现在同时恢复 `client.js` 与 `workspace.js` 两份基线（新增 `workspace.js.orig` 备份），否则上游更新后宿主端优化无法干净重放。
