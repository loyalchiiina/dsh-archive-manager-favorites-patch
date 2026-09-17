// 把 @michengai/dsh-archive-manager 加回 profile 的 dsh.profile.bundles 白名单。
// 该 profile 采用 bundle 白名单模式：不在列表里的插件不会被加载。
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FILE = process.argv[2] ?? join(homedir(), ".dsh", "profiles", "desktop", "package.json");
const TARGET_BUNDLE = "@michengai/dsh-archive-manager";
const BACKUP = process.argv[3];

const original = readFileSync(FILE, "utf8").replace(/^\ufeff/, "");
const parsed = JSON.parse(original);
const bundles = parsed?.dsh?.profile?.bundles;

if (!Array.isArray(bundles)) {
	console.error("未找到 dsh.profile.bundles 数组，放弃修改。");
	process.exit(1);
}
if (bundles.includes(TARGET_BUNDLE)) {
	console.log(`已存在，无需改动：${TARGET_BUNDLE}`);
	process.exit(0);
}

if (BACKUP) {
	mkdirSync(BACKUP, { recursive: true });
	copyFileSync(FILE, join(BACKUP, "package.json.orig"));
	console.log(`已备份到 ${join(BACKUP, "package.json.orig")}`);
}

// 保留原有缩进风格：取第一个数组元素的缩进作为模板
const firstItemMatch = /"bundles":\s*\[\s*\n([ \t]+)"[^"]+",?/.exec(original);
const indent = firstItemMatch?.[1] ?? "        ";
const anchorMatch = /("bundles":\s*\[)(\s*\n)/.exec(original);
if (!anchorMatch) {
	console.error("无法定位 bundles 数组起点，放弃修改。");
	process.exit(1);
}
const line = `${indent}"${TARGET_BUNDLE}",`;
const patched = original.replace(anchorMatch[0], `${anchorMatch[1]}${anchorMatch[2]}${line}`);

// 写盘前必须能解析且确实包含目标项
const verify = JSON.parse(patched);
const list = verify.dsh.profile.bundles;
if (!list.includes(TARGET_BUNDLE)) {
	console.error("写入内容校验失败：目标项不在列表中，放弃。");
	process.exit(1);
}
writeFileSync(FILE, patched, { encoding: "utf8" });
console.log(`已加入 bundles：${TARGET_BUNDLE}`);
console.log(`bundles 数量：${bundles.length} -> ${list.length}`);
console.log("当前清单：\n  " + list.join("\n  "));
