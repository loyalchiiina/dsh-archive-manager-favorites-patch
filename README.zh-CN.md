## 来源与致谢（必读）

**本插件包由 [loyalchiiina](https://github.com/loyalchiiina) 制作并维护** —— 收藏 / 置顶 / 按轮次排序 / 闲置自动归档等增强功能、发布打包与文档，均由本仓库完成。

| 项目 | 说明 |
|---|---|
| **本包作者 / 维护者** | **[loyalchiiina](https://github.com/loyalchiiina)** —— 本仓库发布的是我制作的增强版 |
| 基线上游（致谢） | [MichengAI/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager) —— 「归档会话」插件，作者 **MichengAI**；本包的**基础能力与原始设计**来自他的项目，**在此致谢** |
| 基线版本 | **v0.1.40**（其发布产物构成底座，增强层在其上打补丁） |
| 许可证 | Apache License 2.0（沿用上游许可证原文 `LICENSE`；修改声明见 `NOTICE`） |

按 Apache-2.0 要求，**基线既有代码的版权仍归 MichengAI 所有**；而下方「本版新增的功能」所列全部内容，均由 loyalchiiina 编写与维护。

### 本 fork 新增的功能

1. **收藏归档会话**：列表行内星标 + 侧栏会话菜单收藏；「只看收藏」筛选；收藏项在分组内置顶；删除聊天后自动清理失效收藏。
2. **一键删除未收藏**：两个范围 —— 全部归档中未收藏的会话 / 仅当前筛选结果内未收藏的会话，复用原有确认弹窗并使用专属文案。
3. **置顶会话**：侧栏会话菜单可置顶，置顶项在其所在分组内始终排最前，且不改动宿主的手动排序数据。
4. **按对话轮次排序**：归档列表新增「对话轮次」排序并在每行显示「n 轮」。轮次由宿主端直接读取会话转录统计（口径与官方 `sessionStats` 一致），**不调用任何模型、零 token 消耗**，结果按持久化版本缓存。
5. **复制会话 ID / 转录文件路径**：侧栏会话菜单三项复制能力，路径经官方持久化后端解析（压缩格式由后端处理），并提供只读的本机 HTTP 路由。
6. **归档设置界面排版重整**：每行改为两行排布（标题不再被按钮挤压），工具栏与批量操作头部改为分组卡片。
7. **精简界面**：本 fork 隐藏了头部的「GitHub」「问题反馈」外链与「检查更新」按钮（纯界面取舍，不影响任何功能）。

> ⚠️ 本包与上游 `@michengai/dsh-archive-manager` **不能同时安装**：两者提供同名宿主服务（workspace / 投影缓存 / ui-workspace），同时启用会互相覆盖。请二选一。

---

## 功能总览 · At a glance（中英对照 / Bilingual）

*在上游 v0.1.40 之上增强的功能。*

### 收藏与筛选 · Favorites & filtering

| 中文 | English |
|---|---|
| 会话收藏：行内星标 + 侧边栏菜单入口，「只看收藏」一键过滤 | Favorites for archived sessions: inline stars + sidebar menu entries and a "favorites only" filter |
| 收藏项在分组内自动排最前；删除聊天后自动清理失效收藏 | Favorited-first ordering inside each group; auto-pruning when chats are deleted |
| 一键删除全部未收藏 / 当前筛选结果内未收藏 | One-click delete of unfavorited chats — all archives or only the current filtered results |

### 置顶与排序 · Pinning & sorting

| 中文 | English |
|---|---|
| 会话置顶：侧边栏「…」菜单置顶/取消，置顶项在组内始终排最前（不改动宿主手动排序数据） | Pin sessions from the sidebar menu; pinned rows sort first in their group without touching the host's manual ordering |
| 按时间三态排序：关闭 / 降序（新→旧）/ 升序（旧→新），置顶组整体优先 | New time sorting: off / newest-first / oldest-first, pins always ahead |
| 按对话轮次排序 + 每行轮次徽标；本地统计零 token（口径同官方 sessionStats） | New "Turns" sort with a per-row badge, computed locally — zero model calls, zero tokens |

### 一键归档 · One-click archive

| 中文 | English |
|---|---|
| 按闲置天数一键归档：设置阈值 → 实时统计闲置会话 → 逐条归档 + 进度条 | Idle-days archive: set the threshold, see "N idle over X days", archive with a live progress bar |
| 一键撤回上一步归档 | One-step undo of the last archive run |
| 判定以最后一次对话时间为准；只统计侧边栏可见的未归档会话 | Judged by last-conversation time; only visible unarchived sessions are counted |

### 删除与复制 · Delete & copy

| 中文 | English |
|---|---|
| 批量删除提速（修复上游 O(n²) 全盘扫描 → 索引 + 缓存 + 并发），90 秒+ → 几秒 | Bulk delete speed-up (upstream O(n²) scan → indexed cache + concurrency): 90s+ → seconds |
| 删除进度条 + 每步超时保护 + 安全/快速/分批/原版四级降级链 | Progress bar, per-step timeout, 4-tier fallback chain (safe → fast → batched → original) |
| 侧边栏菜单复制会话 ID / 转录文件路径 / ID+路径（三选） | Sidebar menu copies session ID / transcript path / both |

### 界面与协同 · UI & coexistence

| 中文 | English |
|---|---|
| 归档设置界面排版重整：两行排布 + 工具栏/批量操作分组卡片 | Reworked archive-settings layout: two-line rows, grouped toolbar & batch-action cards |
| 隐藏上游「GitHub / Issues」外链与「检查更新」按钮（纯界面取舍） | Hides upstream GitHub / Issues links and the update-check button (pure UI preference) |
| 与上游 `@michengai/dsh-archive-manager` 不能共存（同名宿主服务），请二选一 | Cannot coexist with upstream `@michengai/dsh-archive-manager` (same host services) — install one |

---

<div align="center">

# DSH Archive Manager

  **在 DeepSeek Harness 中安全管理已归档会话**

  [English](README.md) · [更新日志](CHANGELOG.zh-CN.md) · [Apache-2.0](LICENSE)

  [![许可证：Apache-2.0](https://img.shields.io/badge/许可证-Apache--2.0-blue.svg)](LICENSE)
  [![npm package](https://img.shields.io/npm/v/%40michengai%2Fdsh-archive-manager.svg?label=npm%20package)](https://www.npmjs.com/package/@michengai/dsh-archive-manager)
  [![npm 下载量](https://img.shields.io/npm/dt/%40michengai%2Fdsh-archive-manager.svg?label=npm%20%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://www.npmjs.com/package/@michengai/dsh-archive-manager)
  [![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/MichengAI/dsh-archive-manager)
</div>

> DSH Archive Manager 是社区维护的 DeepSeek Harness（DSH）插件，并非 DeepSeek AI 官方产品。

## 你可以用它做什么

把暂时不用的会话收起来，需要时再找回，让日常任务列表更清爽。

- **归档会话**：收起单条聊天，或整个工作区的未归档聊天。
- **找回历史**：搜索会话标题，按项目筛选，按时间或标题排序。
- **恢复任务**：恢复单条、选中的会话、整个项目或全部归档会话。
- **清理记录**：确认后永久删除不再需要的归档会话。

## 界面预览

在侧栏会话菜单里直接归档、置顶与排序会话：

![侧边栏会话菜单与排序](assets/sidebar-menu-sort.png)

在「设置 → 归档会话」集中查找、恢复和清理：

![归档会话管理页](assets/screenshots/archived-sessions.png)

## 前置条件

- 已能正常使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web，并可在终端运行 `dsh`。
- 当前支持 DSH `0.1.0-rc.8`、`0.1.1-rc.2`、`0.1.2-rc.1`、`0.1.5-rc.1`、`0.1.5-rc.2`；其他版本暂未纳入支持范围。
- Node.js 版本需满足 `^22.19.0 || >=24.0.0`；从源码安装还需要 pnpm。

## 安装

以下示例使用 `web` profile，请替换为你实际使用的 profile。

### 让 Agent 帮你安装

把下面这段话发给能执行本机终端命令的 Agent：

```text
请将 dsh-archive-manager-pro 最新版安装到本机 DSH 的 web profile，使用官方 npm 源。安装后检查插件配置，并告诉我如何重新加载 DSH、进入归档会话管理页。
```

### 手动安装

在 PowerShell 中执行：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

dsh plugin --profile web add dsh-archive-manager-pro@latest --registry=https://registry.npmjs.org/
```

安装后重启 DSH Web，并按 `Ctrl+Shift+R` 硬刷新浏览器。打开「设置 → 归档会话」即可使用。

## 使用

| 你想做什么 | 操作 |
| --- | --- |
| 归档一条会话 | 打开侧栏会话菜单，选择「归档会话」 |
| 归档整个工作区 | 打开工作区菜单，选择归档该工作区的会话 |
| 查找归档 | 打开「设置 → 归档会话」，搜索标题或按项目筛选 |
| 调整排列顺序 | 按更新时间、创建时间或标题排序 |
| 恢复一条会话 | 点击会话右侧的「取消归档」 |
| 批量恢复或删除 | 勾选会话后使用批量操作；也可使用项目菜单或页面顶部的全部操作 |

切换筛选条件会保留已选会话。批量操作前留意隐藏的已选数量，或先清空选择。

### 查看并继续归档对话

从 `0.1.40` 起支持以下操作：

- **查看对话**：打开 DSH 原生会话页，查看消息、附件和工具详情；可直接继续聊天，保持归档状态。
- **恢复并打开**：取消归档后进入原会话，继续工作。

## 更新

在归档管理页标题处点击「检查更新」。支持自动更新的 DSH CLI 或 Desktop 环境可直接更新；其他环境会提供适用于当前 profile 的手动命令。也可重新执行上面的安装命令。

## 常见问题

### 安装后找不到入口？

先重启 DSH Web 并硬刷新浏览器，确认安装到了当前使用的 profile。仍未显示时，执行：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

dsh --profile web --dump-config
```

配置中应包含 `workspace-archive-manager` 和 `ui-workspace-archive-manager`。若曾在 profile 的 `cordis.patch.yml` 中手动将官方 `ui-workspace` 设为 `disabled: true`，请移除该禁用覆盖，再重启。

### 归档和删除有什么区别？

归档只是收起会话，可以恢复。**永久删除无法撤销**，并可能一并清理该会话的附件；不会删除你的项目工作目录。删除前会要求确认。

### 可以和 Codex UI 一起使用吗？

可以。保留 [Codex UI](https://github.com/MichengAI/dsh-codex-ui) 的侧栏样式和交互，归档管理仍在「设置 → 归档会话」中。

遇到其他问题，请提交 [Issue](https://github.com/MichengAI/dsh-archive-manager/issues)，附上 DSH 与插件版本、复现步骤和错误信息。

## 从源码安装

<details>
<summary>开发或测试未发布改动时展开</summary>

在你选择的源码目录中执行以下命令。未推送的本地改动需使用已有工作副本。

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

git clone https://github.com/MichengAI/dsh-archive-manager.git
Set-Location .\dsh-archive-manager
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add .
```

完成后重启 DSH Web 并硬刷新浏览器。修改 [src](src) 中的源码，不直接编辑生成目录 `lib`；使用 `pnpm test` 验证修改，使用 `pnpm verify` 执行完整检查。

</details>

## 相关项目

[DSH Codex UI](https://github.com/MichengAI/dsh-codex-ui) 提供项目与会话管理界面；想使用桌面工作台，可查看 [DSH Codex Desktop](https://github.com/MichengAI/dsh-codex-desktop)。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
