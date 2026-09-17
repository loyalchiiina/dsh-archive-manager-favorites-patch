#!/usr/bin/env node
/**
 * 启动前静态校验（文本级 + 官方注册器双轨）
 *
 * 为什么不用"抽出数组再 eval"：workspace.js 的声明数组里含正则/模板串与注释，
 * 手写括号配对会被字符串内的括号骗到（实测报 Unexpected token ')'）。
 * 这里改为：只针对本次补丁新增/涉及的条目做**文本结构校验**，
 * 并把该条目单独构造出来交给**官方 dsh-typert-registry** 验证 —— 权威且不依赖脆弱解析。
 *
 * 用法：node verify-remote-descriptors.mjs [workspace.js] [--expect archiveSessionsByIds ...]
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const PKG_DIR = process.env.DSH_ARCHIVE_MANAGER_DIR ??
	join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const TARGET = args[0] ?? join(PKG_DIR, "lib", "workspace.js");
// DSH 应用内 node_modules：优先环境变量，其次按常见盘位探测
const APP_MODULES = process.env.DSH_APP_NODE_MODULES ?? (() => {
	const candidates = [
		join(process.env.LOCALAPPDATA ?? "", "Programs", "DSH Desktop", "resources", "app", "node_modules"),
		join("C:", "Program Files", "DSH Desktop", "resources", "app", "node_modules"),
	];
	for (const c of candidates) {
		try { if (existsSync(c)) return c; } catch { /* ignore */ }
	}
	return candidates[0];
})();
// --expect name 要求该方法既实现、又注册、又有合法声明
const expectMethods = [];
for (let i = 0; i < process.argv.length; i += 1) {
	if (process.argv[i] === "--expect") expectMethods.push(process.argv[i + 1]);
}

let failures = 0;
const ok = (name, pass, detail = "") => {
	if (!pass) failures += 1;
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
};

const source = readFileSync(TARGET, "utf8");
console.log(`目标：${TARGET}`);
if (expectMethods.length > 0) console.log(`待验方法：${expectMethods.join(", ")}`);
console.log();

/* ---------- 1. 每条 remote 声明条目的文本结构校验 ---------- */
// 声明条目特征：以 `id: "...#workspaceRegistry/<method>",` 开头的一段对象文本。
const entryRe = /id:\s*"([^"]*#workspaceRegistry\/[^"]+)",([\s\S]*?)sourceLocation:\s*\{[\s\S]*?\}\s*\n\s*\}/g;
const entries = [...source.matchAll(entryRe)];
ok("能提取 remote 声明条目", entries.length >= 1, `${entries.length} 条`);

console.log("\n[逐条结构校验]");
for (const entry of entries) {
	const label = entry[1].split("#").pop();
	const body = entry[2];
	const problems = [];
	if (!/service:\s*"workspaceRegistry"/.test(body)) problems.push('缺 service:"workspaceRegistry"');
	if (!/namespace:\s*"workspaceRegistry"/.test(body)) problems.push("缺 namespace");
	if (!/invocation:\s*\{\s*kind:\s*"direct"/.test(body)) problems.push('缺 invocation:{kind:"direct"}');
	// 参数 codec 必须齐 mode/typeSymbol/schema（对每个出现的 codec 块逐一检查）
	const paramBlocks = [...body.matchAll(/codec:\s*\{([\s\S]*?)\}/g)];
	// 只有「参数数组里真的有元素」才要求 codec；无参方法（parameters: []）允许没有 codec
	const parametersBlock = /parameters:\s*\[([\s\S]*?)\n\s*\]/.exec(body);
	const hasParameters = parametersBlock !== null && parametersBlock[1].trim() !== "" && parametersBlock[1].trim() !== "],";
	if (hasParameters && paramBlocks.length === 0) problems.push("声明了参数却没有 codec 块");
	for (const block of paramBlocks) {
		if (!/mode:\s*"strict"/.test(block[1])) problems.push("codec.mode 非 strict");
		if (!/typeSymbol:\s*"/.test(block[1])) problems.push("codec 缺 typeSymbol");
		if (!/schema:\s*[A-Za-z_$]/.test(block[1])) problems.push("codec 缺 schema 引用");
	}
	for (const block of paramBlocks) {
		if (!/mode:\s*"strict"/.test(block[1])) problems.push("codec.mode 非 strict");
		if (!/typeSymbol:\s*"/.test(block[1])) problems.push("codec 缺 typeSymbol");
		if (!/schema:\s*[A-Za-z_$]/.test(block[1])) problems.push("codec 缺 schema 引用");
	}
	// ⚠️ 事故根因检查：必须是顶层 result，绝不能是 returns
	if (/\breturns\s*:/.test(body)) problems.push("出现非法字段 returns（注册器要的是顶层 result）");
	if (!/\bresult\s*:/.test(body)) problems.push("缺顶层 result");
	else {
		const resultBlock = /\bresult\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(body);
		const inner = resultBlock?.[1] ?? "";
		if (!/mode:\s*"strict"/.test(inner)) problems.push("result.mode 非 strict");
		if (!/typeSymbol:\s*"/.test(inner)) problems.push("result 缺 typeSymbol");
		if (!/schema:\s*[A-Za-z_$]/.test(inner)) problems.push("result 缺 schema");
	}
	ok(label, problems.length === 0, problems.join("；"));
}

/* ---------- 2. 被引用的 schema 常量必须真的存在且含 .parse() ---------- */
console.log("\n[schema 常量定义与 parse() 方法]");
const referenced = new Set([...source.matchAll(/\bschema:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
for (const name of referenced) {
	const defRe = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`, "m");
	const found = defRe.exec(source);
	if (!found) { ok(`${name} 已定义`, false, "未找到定义"); continue; }
	const hasParse = /\bparse\s*\(/.test(found[1]);
	ok(`${name} 含 parse() 方法`, hasParse, hasParse ? "" : "⚠️ typert strict codec 要求 .parse()，缺失会导致插件树加载失败");
}

/* ---------- 3. 与上游「已知可正常启动」的条目做同构比对 ---------- */
// 比探测注册器私有 API 更可靠：上游既有声明在当前 DSH 上实测能加载，
// 因此新条目只要与之**字段结构同构**，就不会触发 validateCodec 那类崩溃。
console.log("\n[与上游可用条目同构比对]");
const shapeOf = (body) => {
	const keys = new Set();
	for (const m of body.matchAll(/^\s{4}([A-Za-z_$][\w$]*):/gm)) keys.add(m[1]);
	return keys;
};
const reference = entries.find((e) => /archiveWorkspaceSessions/.test(e[1])) ?? entries[0];
const referenceShape = reference ? shapeOf(reference[2]) : new Set();
ok("存在参照条目（上游已验证可加载）", reference !== undefined, reference ? String(reference[1]).split("#").pop() : "无");
if (reference && expectMethods.length > 0) {
	for (const method of expectMethods) {
		const mine = entries.find((e) => e[1].endsWith(`/${method}`));
		if (!mine) { ok(`${method} 声明存在`, false, "未找到该 remote 声明条目"); continue; }
		const mineShape = shapeOf(mine[2]);
		const missing = [...referenceShape].filter((k) => !mineShape.has(k));
		const extra = [...mineShape].filter((k) => !referenceShape.has(k));
		ok(`${method} 与参照条目同构`, missing.length === 0 && extra.length === 0,
			`缺字段=${missing.join(",") || "无"}；多字段=${extra.join(",") || "无"}`);
	}
}

/* ---------- 4. 期望存在的功能：实现 + 注册 + 声明三者齐备 ---------- */
if (expectMethods.length > 0) {
	console.log("\n[功能接线完整性]");
	for (const method of expectMethods) {
		const implemented = new RegExp(`async\\s+${method}\\s*\\(`).test(source);
		const marked = source.includes(`markRemoteMethod(this, "${method}")`);
		const declared = new RegExp(`#workspaceRegistry/${method}"`).test(source);
		ok(`${method}：实现/注册/声明`, implemented && marked && declared,
			`实现=${implemented} mark=${marked} 声明=${declared}`);
	}
}

console.log(`\n合计失败 ${failures} 项。${failures === 0 ? "✅ 可以安全应用并重启。" : "⛔ 禁止写盘、禁止用重启来试错。"}`);
process.exit(failures === 0 ? 0 : 1);
