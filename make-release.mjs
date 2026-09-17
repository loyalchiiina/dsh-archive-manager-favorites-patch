#!/usr/bin/env node
/**
 * 生成自维护发布包 dsh-archive-manager-plus
 *
 * 内容基准：**本机当前安装的 @michengai/dsh-archive-manager 0.1.40（含全部本地补丁）**，
 * 即用户实际在用的那一份（收藏 / 复制 ID·路径 / 置顶 / 轮次排序 / 排版重整 / 隐藏上游链接）。
 *
 * 改名规则（必须三处一致，否则 __ModuleLoader__ 报 loaded without registering）：
 *   - package.json name
 *   - cordis.patch.yml 的三个服务 name
 *   - lib/client.js 里 __ModuleLoader__.load({ id }) 及全部 cordis 元数据 id/typeSymbol
 * 同时改写 HTTP 路由前缀，避免与原版插件争抢同一路由（duplicate entry）。
 *
 * Apache-2.0 合规：保留原 LICENSE、新增 NOTICE 与 README 来源声明、标注本仓库为修改版。
 *
 * 用法：node make-release.mjs [--out <dir>]
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";

const SOURCE = process.env.DSH_ARCHIVE_MANAGER_DIR ??
  join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager");
const OUT = resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : join(homedir(), "Documents", "deepseekharness", "plugins", "dsh-archive-manager-plus"));

const OLD_ID = "@michengai/dsh-archive-manager";
const NEW_ID = "dsh-archive-manager-plus";
const OLD_API = "api/michengai/dsh-archive-manager";
const NEW_API = "api/dsh-archive-manager-plus";
const UPSTREAM_URL = "https://github.com/MichengAI/dsh-archive-manager";
const BASE_VERSION = "0.1.40";
const RELEASE_VERSION = "0.1.40-plus.1";
const REPO_URL = "https://github.com/loyalchiiina/dsh-archive-manager-favorites-patch";  // A 方案：上传统一用本仓库

function writeText(path, text) {
	// UTF-8 无 BOM（DSH 加载器不接受 BOM）
	writeFileSync(path, text.replace(/^\ufeff/, ""), { encoding: "utf8" });
}

function readText(path) {
	return readFileSync(path, "utf8").replace(/^\ufeff/, "");
}

/** 对文本做标识替换；返回替换次数统计。 */
function rebrand(text) {
	let scopeHits = 0;
	let apiHits = 0;
	scopeHits = text.split(OLD_ID).length - 1;
	text = text.split(OLD_ID).join(NEW_ID);
	apiHits = text.split(OLD_API).length - 1;
	text = text.split(OLD_API).join(NEW_API);
	return { text, scopeHits, apiHits };
}

const FILES_TO_REBRAND = [
	"package.json",
	"cordis.patch.yml",
	"lib/client.js",
	"lib/index.js",
	"lib/workspace.js",
	"lib/projcache.js",
	"lib/tombstone.js",
	"lib/archive-experience.js",
	"lib/plugin-updater.js",
	"lib/session-path.js",
	"lib/turn-counts.js",
];

function copyTree(from, to, skipNames) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from)) {
		if (skipNames.includes(entry)) continue;
		const src = join(from, entry);
		const dst = join(to, entry);
		if (statSync(src).isDirectory()) {
			copyTree(src, dst, skipNames);
		} else {
			cpSync(src, dst);
		}
	}
}

function buildPackageJson() {
	const path = join(OUT, "package.json");
	const raw = JSON.parse(readText(path));
	raw.name = NEW_ID;
	raw.version = RELEASE_VERSION;
	raw.description =
		"归档会话增强版（fork 自 @michengai/dsh-archive-manager v0.1.40）：收藏与一键删除未收藏、置顶会话、按对话轮次排序、复制会话 ID 与转录文件路径、归档界面排版重整。";
	raw.homepage = REPO_URL;
	raw.repository = { type: "git", url: `${REPO_URL}.git` };
	raw.bugs = { url: `${REPO_URL}/issues` };
	// 2026-09-17 用户决策：author = 本包制作者 loyalchiiina（显示"我做的"）；
	// 上游 MichengAI 保留在 contributors + NOTICE + LICENSE（Apache-2.0 合规：保留版权与许可原文即可，
	// 不要求在 author 字段署名原作者）。
	raw.author = { name: "loyalchiiina", url: "https://github.com/loyalchiiina", email: "" };
	raw.contributors = [
		{ name: "loyalchiiina", url: "https://github.com/loyalchiiina", note: "本增强版制作者与维护者" },
		{ name: "MichengAI", url: UPSTREAM_URL, note: `上游作者，本包基于其 ${BASE_VERSION} 版本修改（致谢）` },
	].concat(Array.isArray(raw.contributors) ? raw.contributors : []);
	raw.keywords = Array.from(new Set([...(raw.keywords ?? []), "dsh-plugin", "archive", "favorites", "pin", "fork"])).slice(0, 16);
	// 更新说明指向本仓库，安装命令同步改名
	raw.dsh = raw.dsh ?? {};
	writeText(path, JSON.stringify(raw, null, 2) + "\n");
	return raw;
}

const NOTICE = `dsh-archive-manager-plus
Copyright (c) 2026 loyalchiiina

This product includes software developed by MichengAI as part of the
"dsh-archive-manager" project (https://github.com/MichengAI/dsh-archive-manager),
licensed under the Apache License, Version 2.0.

This is a MODIFIED version. Based on upstream version 0.1.40.
Modifications (all added in this fork):

  - Favorites for archived sessions: star rows and sidebar menu entries,
    "favorites only" filter, favorited-first ordering, one-click deletion of
    unfavorited archived sessions (all / current filter), favorites pruned on delete.
  - Pin sessions to top from the sidebar session menu (per-group precedence,
    manual ordering data untouched).
  - Sort archived sessions by conversation turn count, plus a per-row turn badge.
    Turn counts are derived locally from session transcripts with the same
    semantics as official \`sessionStats\`; no model calls, zero token cost.
  - Sidebar session menu clipboard helpers: copy session ID, copy transcript file
    path resolved through the persistence backend, or copy both at once.
  - Archive settings layout rework: two-line rows so titles stop being squeezed,
    carded toolbar and batch-action header.
  - Hidden the upstream project links ("GitHub", "Issues") and the built-in
    "check for updates" button in this fork's UI.

The original LICENSE (Apache License 2.0) is retained unmodified in the LICENSE file.
See README.md / README.zh-CN.md for the full attribution and changelog of this fork.
`;

const SOURCE_SECTION_ZH = `## 来源与致谢（必读）

**本插件包由 [loyalchiiina](https://github.com/loyalchiiina) 制作并维护** —— 收藏 / 置顶 / 按轮次排序 / 闲置自动归档等增强功能、发布打包与文档，均由本仓库完成。

| 项目 | 说明 |
|---|---|
| **本包作者 / 维护者** | **[loyalchiiina](https://github.com/loyalchiiina)** —— 本仓库发布的是我制作的增强版 |
| 基线上游（致谢） | [MichengAI/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager) —— 「归档会话」插件，作者 **MichengAI**；本包的**基础能力与原始设计**来自他的项目，**在此致谢** |
| 基线版本 | **v0.1.40**（其发布产物构成底座，增强层在其上打补丁） |
| 许可证 | Apache License 2.0（沿用上游许可证原文 \`LICENSE\`；修改声明见 \`NOTICE\`） |

按 Apache-2.0 要求，**基线既有代码的版权仍归 MichengAI 所有**；而下方「本版新增的功能」所列全部内容，均由 loyalchiiina 编写与维护。

### 本 fork 新增的功能

1. **收藏归档会话**：列表行内星标 + 侧栏会话菜单收藏；「只看收藏」筛选；收藏项在分组内置顶；删除聊天后自动清理失效收藏。
2. **一键删除未收藏**：两个范围 —— 全部归档中未收藏的会话 / 仅当前筛选结果内未收藏的会话，复用原有确认弹窗并使用专属文案。
3. **置顶会话**：侧栏会话菜单可置顶，置顶项在其所在分组内始终排最前，且不改动宿主的手动排序数据。
4. **按对话轮次排序**：归档列表新增「对话轮次」排序并在每行显示「n 轮」。轮次由宿主端直接读取会话转录统计（口径与官方 \`sessionStats\` 一致），**不调用任何模型、零 token 消耗**，结果按持久化版本缓存。
5. **复制会话 ID / 转录文件路径**：侧栏会话菜单三项复制能力，路径经官方持久化后端解析（压缩格式由后端处理），并提供只读的本机 HTTP 路由。
6. **归档设置界面排版重整**：每行改为两行排布（标题不再被按钮挤压），工具栏与批量操作头部改为分组卡片。
7. **精简界面**：本 fork 隐藏了头部的「GitHub」「问题反馈」外链与「检查更新」按钮（纯界面取舍，不影响任何功能）。

> ⚠️ 本包与上游 \`@michengai/dsh-archive-manager\` **不能同时安装**：两者提供同名宿主服务（workspace / 投影缓存 / ui-workspace），同时启用会互相覆盖。请二选一。

---

`;

function patchReadmes() {
	for (const file of ["README.zh-CN.md", "README.md"]) {
		const path = join(OUT, file);
		let text = readText(path);
		const banner = file.endsWith("zh-CN.md")
			? SOURCE_SECTION_ZH
			: SOURCE_SECTION_EN;
		// 插到一级标题之后
		const heading = /^#[^\n]*\n/;
		if (heading.test(text)) {
			text = text.replace(heading, (m) => m + "\n" + banner);
		} else {
			text = banner + text;
		}
		text = text.split(OLD_ID).join(NEW_ID);
		writeText(path, text);
	}
}

const SOURCE_SECTION_EN = `## Provenance & credits (please read)

**This package is built and maintained by [loyalchiiina](https://github.com/loyalchiiina)** — the favorites / pin / turns / auto-archive enhancements, the release packaging and the current documentation are all authored here.

| Item | Detail |
|---|---|
| Package author / maintainer | **[loyalchiiina](https://github.com/loyalchiiina)** — the enhanced build published in this repository |
| Baseline upstream | [MichengAI/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager) — the "Archived sessions" plugin by **MichengAI**; all baseline capabilities and the original design come from his project (**thank you!**) |
| Baseline version | **v0.1.40** (that release's code forms the base layer, patched on top) |
| License | Apache License 2.0 (upstream \`LICENSE\` retained verbatim; modifications documented in \`NOTICE\`) |

Copyright of the pre-existing baseline code remains with MichengAI as required by Apache-2.0; everything documented under "what this adds" below is authored and maintained by loyalchiiina.

### What this fork adds

1. **Favorites for archived sessions** — inline star buttons plus sidebar menu entries, a "favorites only" filter, favorited-first ordering inside each group, and automatic pruning when chats are deleted.
2. **One-click delete of unfavorited chats** — two scopes: all archived chats outside favorites, or only those in the current filtered results, sharing the existing confirmation dialog.
3. **Pin sessions** — pin from the sidebar session menu; pinned rows always sort first within their group without touching the host's manual ordering data.
4. **Sort by conversation turns** — a new "Turns" sort plus a per-row turn badge. Counts are derived locally from session transcripts with the same semantics as official \`sessionStats\`: **no model calls, zero token cost**, cached per persisted revision.
5. **Copy session ID / transcript path** — three clipboard entries in the sidebar menu; paths are resolved through the official persistence backend via a loopback-only read route.
6. **Archive settings layout rework** — rows wrap onto two lines so titles are no longer squeezed; toolbar and batch-action header become grouped cards.
7. **Trimmed UI** — this fork hides the "GitHub" / "Issues" header links and the built-in "check for updates" button (a pure UI preference, no functional impact).

> ⚠️ This package **cannot coexist** with upstream \`@michengai/dsh-archive-manager\`: both provide the same host services (workspace / projection cache / ui-workspace). Install one of them.

---

`;

function main() {
	if (!statSync(SOURCE).isDirectory()) {
		console.error(`找不到源插件目录：${SOURCE}`);
		process.exit(2);
	}
	rmSync(OUT, { recursive: true, force: true });
	copyTree(SOURCE, OUT, ["node_modules"]);
	console.log(`已复制安装包 -> ${OUT}`);

	const report = [];
	for (const rel of FILES_TO_REBRAND) {
		const path = join(OUT, rel);
		try {
			const original = readText(path);
			const { text, scopeHits, apiHits } = rebrand(original);
			writeText(path, text);
			report.push(`  ${rel.padEnd(26)} id×${String(scopeHits).padStart(2)}  路由×${apiHits}`);
		} catch (error) {
			report.push(`  ${rel.padEnd(26)} 跳过（${error.code ?? error.message}）`);
		}
	}
	console.log("标识替换：\n" + report.join("\n"));

	const pkg = buildPackageJson();
	patchReadmes();
	writeText(join(OUT, "NOTICE"), NOTICE);

	// CHANGELOG 顶部加 fork 条目
	for (const [file, head] of [["CHANGELOG.zh-CN.md", "# 更新日志\n"], ["CHANGELOG.md", "# Changelog\n"]]) {
		const path = join(OUT, file);
		let text = readText(path);
		const entry = file.includes("zh-CN")
			? `\n## ${RELEASE_VERSION} - 本 fork（基线上游 ${BASE_VERSION}）\n\n- 新增：归档收藏、「只看收藏」、收藏置顶、删除聊天后清理收藏。\n- 新增：一键删除未收藏的归档聊天（全部 / 当前筛选内两种范围）。\n- 新增：侧栏会话菜单置顶会话（分组内优先，不改手动排序数据）。\n- 新增：按对话轮次排序与每行「n 轮」显示（本机转录直算，零 token）。\n- 新增：侧栏复制会话 ID、复制转录文件路径、一次复制两者。\n- 调整：归档设置界面两行布局与分区卡片化。\n- 调整：本 fork 隐藏「GitHub」「问题反馈」外链与「检查更新」按钮。\n- 说明：以上均基于 MichengAI/dsh-archive-manager v${BASE_VERSION}，原始功能与版权归属原作者。\n`
			: `\n## ${RELEASE_VERSION} - this fork (baseline upstream ${BASE_VERSION})\n\n- Added: favorites for archived chats, "favorites only" filter, favorited-first ordering, pruning on delete.\n- Added: one-click deletion of unfavorited archived chats (all / current filter).\n- Added: pin sessions from the sidebar menu (group-level precedence, manual ordering untouched).\n- Added: sort by conversation turns plus a per-row turn badge (computed locally from transcripts, zero tokens).\n- Added: copy session ID, copy transcript path, copy both — from the sidebar menu.\n- Changed: archive settings layout (two-line rows, carded toolbar and header actions).\n- Changed: this fork hides the "GitHub" / "Issues" links and the "check for updates" button.\n- Note: all of the above build on MichengAI/dsh-archive-manager v${BASE_VERSION}; existing features and copyright belong to the original author.\n`;
		const idx = text.indexOf("\n## ");
		text = idx === -1 ? text + entry : text.slice(0, idx) + entry + text.slice(idx);
		writeText(path, text);
	}

	console.log(`\n发布名 = ${pkg.name}@${pkg.version}`);
	console.log(`产物目录 = ${OUT}`);
}

main();
