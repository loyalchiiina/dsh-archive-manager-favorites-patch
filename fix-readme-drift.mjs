#!/usr/bin/env node
/**
 * 修正 rebrand 全局替换在 README 里造成的三处失真（并补上 fork 专属说明）：
 *   A. 「不能同时安装」的对方名字被一起改成了新包名 → 还原为上游 @michengai/dsh-archive-manager
 *   B. 顶部徽章指向未发布的 npm 包与上游包名 → 改为指向上游仓库/本仓库，去掉虚假 npm 徽章
 *   C. 「## 更新」章节仍在讲已被本 fork 隐藏的「检查更新」按钮 → 改写为本 fork 的更新方式
 *   D. 「从源码安装」引导 clone 上游仓库 → 改为 clone 本 fork（并说明本仓库以产物 lib 为准）
 *
 * 用法：node fix-readme-drift.mjs <release-dir> [--dry-run]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2];
if (!ROOT) { console.error("用法：node fix-readme-drift.mjs <release-dir> [--dry-run]"); process.exit(2); }
const dryRun = process.argv.includes("--dry-run");

const UPSTREAM_ID = "@michengai/dsh-archive-manager";
const UPSTREAM_URL = "https://github.com/MichengAI/dsh-archive-manager";
const FORK_URL = "https://github.com/loyalchiiina/dsh-archive-manager-plus";

/** 每个补丁给出锚点与替换文本，命中数必须为 1。 */
const PATCHES_ZH = [
	{
		name: "A-共存警告对象还原",
		find: `> ⚠️ 本包与上游 \`dsh-archive-manager-plus\` **不能同时安装**`,
		to: `> ⚠️ 本包与上游 \`${UPSTREAM_ID}\` **不能同时安装**`,
	},
	{
		name: "B-npm 徽章改为真实指向",
		find: `  [![npm package](https://img.shields.io/npm/v/%40michengai%2Fdsh-archive-manager.svg?label=npm%20package)](https://www.npmjs.com/package/dsh-archive-manager-plus)`,
		to: `  [![fork of ${UPSTREAM_ID} v0.1.40](https://img.shields.io/badge/fork%20of-MichengAI%2Fdsh--archive--manager%20v0.1.40-informational.svg)](${UPSTREAM_URL})`,
	},
	{
		name: "B2-下载量徽章改为基线版本徽章",
		find: `  [![npm 下载量](https://img.shields.io/npm/dt/%40michengai%2Fdsh-archive-manager.svg?label=npm%20%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://www.npmjs.com/package/dsh-archive-manager-plus)`,
		to: `  [![baseline v0.1.40](https://img.shields.io/badge/baseline-v0.1.40-0f766e.svg)](${UPSTREAM_URL}/releases)`,
	},
	{
		name: "C-更新章节改写",
		find: `## 更新\n\n在归档管理页标题处点击「检查更新」。支持自动更新的 DSH CLI 或 Desktop 环境可直接更新；其他环境会提供适用于当前 profile 的手动命令。也可重新执行上面的安装命令。`,
		to: `## 更新\n\n本 fork 隐藏了原版头部的「检查更新」按钮（自更新描述符仍指向上游，误触发会装回官方版并覆盖本包的增强功能），因此请手动更新：\n\n\`\`\`powershell\ndsh plugin --profile web add dsh-archive-manager-plus@latest --registry=https://registry.npmjs.org/\n\`\`\`\n\n或直接重新执行上文安装命令。想查看本包的改动历史，见 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) 顶部的 fork 条目。`,
	},
	{
		name: "D-源码安装改为本仓库",
		find: `git clone https://github.com/MichengAI/dsh-archive-manager.git\nSet-Location .\\dsh-archive-manager`,
		to: `git clone ${FORK_URL}.git\nSet-Location .\\dsh-archive-manager-plus`,
	},
	{
		name: "D2-源码目录说明",
		find: `完成后重启 DSH Web 并硬刷新浏览器。修改 [src](src) 中的源码，不直接编辑生成目录 \`lib\`；使用 \`pnpm test\` 验证修改，使用 \`pnpm verify\` 执行完整检查。`,
		to: `完成后重启 DSH Web 并硬刷新浏览器。\n\n> 注意：本仓库分发的是**产物型 fork** —— 只包含上游 v0.1.40 构建出的 \`lib\`（含本包追加的功能），不含上游构建链路与 \`src\`。要复现这些改动，请在已安装的 \`lib/client.js\` 上按 [NOTICE](NOTICE) 列出的功能点自行调整，或改用上游官方版本。`,
	},
];

const PATCHES_EN = [
	{
		name: "A-共存警告对象还原",
		find: `> ⚠️ This package **cannot coexist** with upstream \`dsh-archive-manager-plus\``,
		to: `> ⚠️ This package **cannot coexist** with upstream \`${UPSTREAM_ID}\``,
	},
	{
		name: "B-npm 徽章改为真实指向",
		find: `  [![npm package](https://img.shields.io/npm/v/%40michengai%2Fdsh-archive-manager.svg?label=npm%20package)](https://www.npmjs.com/package/dsh-archive-manager-plus)`,
		to: `  [![fork of ${UPSTREAM_ID} v0.1.40](https://img.shields.io/badge/fork%20of-MichengAI%2Fdsh--archive--manager%20v0.1.40-informational.svg)](${UPSTREAM_URL})`,
	},
	{
		name: "B2-下载量徽章改为基线版本徽章",
		find: `  [![npm downloads](https://img.shields.io/npm/dt/%40michengai%2Fdsh-archive-manager.svg?label=npm%20downloads)](https://www.npmjs.com/package/dsh-archive-manager-plus)`,
		to: `  [![baseline v0.1.40](https://img.shields.io/badge/baseline-v0.1.40-0f766e.svg)](${UPSTREAM_URL}/releases)`,
	},
	{
		name: "C-更新章节改写",
		find: `## Updates\n\nClick **Check for updates** in the archive management page header. DSH CLI or Desktop environments with automatic update support can update directly; other environments provide a manual command for the current profile. You can also rerun the installation command above.`,
		to: `## Updates\n\nThis fork hides the original **"Check for updates"** button on purpose: the built-in updater descriptor still points at the upstream package, so triggering it would reinstall the official version and wipe this fork's additions. Update manually instead:\n\n\`\`\`powershell\ndsh plugin --profile web add dsh-archive-manager-plus@latest --registry=https://registry.npmjs.org/\n\`\`\`\n\nOr simply rerun the install command above. See the fork entry at the top of [CHANGELOG.md](CHANGELOG.md) for what changed here.`,
	},
	{
		name: "D-源码安装改为本仓库",
		find: `git clone https://github.com/MichengAI/dsh-archive-manager.git\nSet-Location .\\dsh-archive-manager`,
		to: `git clone ${FORK_URL}.git\nSet-Location .\\dsh-archive-manager-plus`,
	},
	{
		name: "D2-源码目录说明",
		find: `Restart DSH Web and hard-refresh your browser afterward. Edit [src](src), not the generated \`lib\` directory. Run \`pnpm test\` to validate changes or \`pnpm verify\` for the full checks.`,
		to: `Restart DSH Web and hard-refresh your browser afterward.\n\n> Note: this repository ships an **artifact-based fork** — only the \`lib\` output built from upstream v0.1.40, plus the features listed in [NOTICE](NOTICE). It does not contain the upstream build pipeline or \`src\`. To reproduce these changes, patch \`lib/client.js\` of an installed copy accordingly, or use the official upstream release instead.`,
	},
];

function apply(text, patches, label) {
	const report = [];
	let failed = 0;
	for (const patch of patches) {
		const count = text.split(patch.find).length - 1;
		if (count === 1) {
			text = text.replace(patch.find, patch.to);
			report.push(`  [ok]   ${patch.name}`);
		} else if (count === 0 && text.includes(patch.to)) {
			report.push(`  [skip] ${patch.name}（已是目标文本）`);
		} else {
			failed += 1;
			report.push(`  [FAIL] ${patch.name} — 锚点命中 ${count} 次`);
		}
	}
	console.log(`${label}\n${report.join("\n")}`);
	return { text, failed };
}

let totalFailed = 0;
for (const [file, patches] of [["README.zh-CN.md", PATCHES_ZH], ["README.md", PATCHES_EN]]) {
	const path = join(ROOT, file);
	const original = readFileSync(path, "utf8").replace(/^\ufeff/, "");
	const result = apply(original, patches, `=== ${file} ===`);
	totalFailed += result.failed;
	if (result.failed === 0 && !dryRun && result.text !== original) {
		writeFileSync(path, result.text, { encoding: "utf8" });
		console.log(`  已写盘 ${file}`);
	}
}

if (totalFailed > 0) { console.error(`\n${totalFailed} 处失配。`); process.exit(1); }
console.log(dryRun ? "\n--dry-run：全部可应用，未写盘。" : "\nREADME 失真已修正。");
