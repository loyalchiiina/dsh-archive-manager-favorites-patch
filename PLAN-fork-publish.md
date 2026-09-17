# 自维护发布计划：dsh-archive-manager 增强分支（fork）

> 目标：把已在本机验证的增强功能（收藏 / 复制会话 ID 与文件路径）做成**自己维护、自己发布**的插件包，
> 同时**完整保留原作者署名与其历史贡献**（Apache-2.0 合规）。
>
> 状态：等待用户重启 DSH 实机验收 → 确认包名/仓库名 → 执行。

---

## 一、事实基线（已勘察）

| 项 | 值 |
|---|---|
| 上游仓库 | `MichengAI/dsh-archive-manager`（Apache-2.0，维护极活跃，2026-09-14 发布 0.1.41） |
| 本机已装 | `@michengai/dsh-archive-manager@0.1.40`（已打 24 处功能补丁） |
| 上游源码 | 已下载到 `upstream/MichengAI-dsh-archive-manager-f3a54b5/`（main 分支，含 `src/`+`scripts/build.mjs`+`test/`） |
| 构建 | `node scripts/build.mjs`（esbuild：宿主端 6 个入口不打包，`src/client.js` → IIFE bundle） |
| 测试 | `test/*.test.mjs`（client / archive-settings-section / workspace-composition / build 等） |
| 工具链 | node v24.19.0、pnpm 11.8.0、npm 11.17.0、gh 已登录 `loyalchiiina`（含 repo 权限） |
| npm 账号 | `loyalchiiina`；既有插件用**无 scope 包名**（例：`dsh-font-enhancer@1.4.10`） |
| 包名占用 | `dsh-archive-manager-fav` 未被占用；`@loyalchiiina/*` 未使用 |

> 注意：上游 main 的 0.1.41 已重构「批量操作栏」（抽出 `ArchiveSelectionToolbar`），与 0.1.40 的
> 内联实现不同。为让改动与**已验证的本机行为**保持一致，基线取上游 tag **v0.1.40** 源码，
> 后续再决定是否 merge main。

---

## 二、发布产物设计

- 包名（待用户确认，建议）：`dsh-archive-manager-plus`
- 版本（待确认）：`1.0.0`（自维护分支自有版本线；README/CHANGELOG 注明基于上游 0.1.40）
- 仓库（待确认）：`loyalchiiina/dsh-archive-manager-plus`（新建并注明 fork 来源；
  或直接 fork 上游仓库以保留血缘）
- 功能 = 上游 0.1.40 全部能力 + 本次 6 项增强：
  1. 归档页星标收藏（localStorage 持久化）
  2. 归档页「只看收藏」筛选 + 已收藏计数
  3. 收藏的归档聊天列表内置顶
  4. 头部「删除全部未收藏」
  5. 工具栏「删除未收藏」（当前筛选范围内）
  6. 侧栏会话菜单：收藏/取消收藏、复制会话 ID、复制会话文件路径、复制 ID + 路径
- 宿主端新增只读路由 `GET /api/michengai/dsh-archive-manager/session-path`

---

## 三、执行步骤

1. **取基线源码**：下载上游 tag `v0.1.40` tarball（`.../tarball/v0.1.40`）到 `upstream-v0140/`。
2. **落位功能改动**：把 `apply-patch.mjs` 的 24 处逻辑套用到 `src/client.js`（改用「忽略行首缩进」的
   自适应锚点引擎，因为 src 用 tab、构建产物用空格）；新增 `src/session-path.js`，改 `src/index.js`。
3. **改名（必须全改，否则加载/remote 失败）**：
   - `package.json` → `name`
   - `cordis.patch.yml` → `insert[].id` 与 `insert[].name`
   - `src/client.js` → `window.__ModuleLoader__.load({ id })`、`ARCHIVE_MANAGER_REMOTE.package`、
     各 descriptor 的 `id` / `typeSymbol`
   - 宿主路由前缀（`/api/michengai/...`）建议改为自己的前缀，避免与上游插件同时安装时冲突
4. **署名与合规（用户明确要求保留原作者贡献）**：
   - 保留上游 `LICENSE`（Apache-2.0 全文）与版权声明，新增 `NOTICE`：
     「本包基于 MichengAI 的 dsh-archive-manager（Apache-2.0）修改，原作者版权归其所有」
   - `README.md` / `README.zh-CN.md` 顶部加显著来源说明 + 上游仓库链接 + 本分支新增功能列表
   - `CHANGELOG.md` **保留上游全部历史版本记录**，在顶部追加本分支条目
   - 修改过的文件在文件头注释标注「Modified from upstream ... (Apache-2.0)」
   - 不使用 `@michengai` scope；不暗示官方背书
5. **构建与测试**：`pnpm install` → `node scripts/build.mjs` → `node --test test/*.test.mjs`
   （上游测试若依赖其 devDependencies，需先安装）；再用本目录两个探针复验。
6. **本地安装自维护包**：**先卸载原版**（两者不能共存：都替换 `workspace` 服务、都占用
   `settings.section id=archived-sessions` 与 `sidebar.workspaces` 插槽）→ 安装自维护包 → 重启 DSH 验收。
7. **发布 GitHub**：新建/ fork 仓库 → 推源码（含 LICENSE/NOTICE/CHANGELOG）→ 加 `dsh-plugin` topic。
8. **发布 npm**（需用户本人确认，publish 权限在用户账号）：`npm.cmd publish --access public`；
   发布前 `npm pack --dry-run` 核对文件清单与敏感信息扫描。

---

## 四、风险与对策

| 风险 | 对策 |
|---|---|
| 改名漏改导致插件加载失败 / remote 调用失败 | 用 grep 全量核验旧包名残留为 0 后再构建 |
| 自维护包与原版共存冲突 | 安装前先卸载原版；README 明确「不要与原版同时安装」 |
| 上游后续版本无法直接 merge | 本分支只在少数文件改动，保留 `CHANGELOG` 与上游 tag 记录，便于 rebase |
| npm 发布需实名凭据 | publish 由用户执行或用户明确授权后由我代跑（本机已登录 loyalchiiina） |
| 上游若合并同类功能 | 届时废弃本分支，切回官方包 |

---

## 五、待用户确认

1. 包名：`dsh-archive-manager-plus`（建议）或其它？
2. 仓库：新建 `loyalchiiina/dsh-archive-manager-plus`，还是先 fork 上游仓库再改？
3. 是否同时发布到 npm（`loyalchiiina` 账号）？
4. 基线：确认为上游 `v0.1.40`（与本机已验证行为一致）而非 main（0.1.41 已重构批量栏）。
