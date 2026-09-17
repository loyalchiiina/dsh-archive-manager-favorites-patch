#!/usr/bin/env node
/**
 * 发布前自检：dsh-archive-manager-plus
 *   1. 三处 id 一致（package.json name / cordis.patch.yml 服务名 / __ModuleLoader__.load id）
 *   2. 所有 JS 语法通过
 *   3. 无 UTF-8 BOM、无 CRLF 混入
 *   4. bundle 可被 __ModuleLoader__ 正常注册（DOM stub 探针）
 *   5. 敏感信息扫描（API key / 本机绝对路径 / 用户名 / 内网地址 / 邮箱 / 私钥）
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.argv[2] ?? join(process.cwd(), "..", "dsh-archive-manager-plus");
const EXPECT_ID = "dsh-archive-manager-plus";
let failures = 0;
const ok = (name, pass, detail = "") => {
	if (!pass) failures += 1;
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
};
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

console.log(`目标：${ROOT}\n`);

/* ---------- 1. id 三处一致 ---------- */
console.log("[1] 标识一致性");
const pkg = JSON.parse(read("package.json"));
ok("package.json name", pkg.name === EXPECT_ID, pkg.name);
const patchYml = read("cordis.patch.yml");
const serviceNames = [...patchYml.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
ok(
	"cordis.patch.yml 三个服务名均以新 id 为前缀",
	serviceNames.length === 3 && serviceNames.every((n) => n.startsWith(EXPECT_ID)),
	serviceNames.join(", ")
);
ok("cordis.patch.yml 不再含旧 scope", !patchYml.includes("@michengai/"));
const client = read("lib/client.js");
const loaderId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(client)?.[1];
ok("__ModuleLoader__.load id 与包名一致", loaderId === EXPECT_ID, String(loaderId));
ok("client.js 不含旧 scope 残留", !client.includes("@michengai/dsh-archive-manager"));
ok("HTTP 路由已改前缀（不与原版冲突）", !client.includes("api/michengai/") && client.includes("api/dsh-archive-manager-plus/"));
const hostIndex = read("lib/index.js");
ok("宿主 packageName 指向新包", hostIndex.includes(`packageName: "${EXPECT_ID}"`) && !hostIndex.includes("@michengai/"));
const remotePkg = /ARCHIVE_MANAGER_REMOTE\s*=\s*\{[\s\S]{0,200}?package:\s*"([^"]+)"/.exec(client)?.[1];
ok("自更新描述符 package 已改名", remotePkg === EXPECT_ID || remotePkg === void 0, String(remotePkg));

/* ---------- 2. 语法 ---------- */
console.log("\n[2] JS 语法（spawn node --check）");
const jsFiles = [];
(function walk(dir) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full);
		else if (entry.endsWith(".js")) jsFiles.push(relative(ROOT, full));
	}
})(ROOT);
for (const file of jsFiles) {
	const { spawnSync } = await import("node:child_process");
	const r = spawnSync(process.execPath, ["--check", join(ROOT, file)], { encoding: "utf8" });
	ok(`node --check ${file}`, r.status === 0, r.stderr?.trim().split("\n")[0] ?? "");
}

/* ---------- 3. 编码 ---------- */
console.log("\n[3] 编码卫生（BOM / CRLF）");
const textFiles = [...jsFiles, "package.json", "cordis.patch.yml"].filter((f) => f.endsWith(".js") || f.endsWith(".json") || f.endsWith(".yml"));
for (const file of textFiles) {
	const bytes = readFileSync(join(ROOT, file));
	const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	const crlf = read(file).includes("\r\n");
	if (bom || crlf) ok(`${file}`, false, `${bom ? "有 BOM " : ""}${crlf ? "有 CRLF" : ""}`);
}
ok("全部文本产物无 BOM 且为 LF", true, `${textFiles.length} 个文件`);

/* ---------- 4. bundle 可注册 ---------- */
console.log("\n[4] bundle 注册探针（DOM stub）");
const domNode = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null, appendChild(c) { return c; }, append() {}, removeChild() {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, insertBefore(c) { return c; }, closest: () => null, dataset: {}, children: [], focus() {}, blur() {}, contains: () => false });
const domNodeProto = Object.create(null);
const documentStub = {
	body: domNode(), head: domNode(), documentElement: domNode(),
	createElement: () => domNode(), createElementNS: () => domNode(), createTextNode: (t) => ({ nodeValue: t }),
	querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
	addEventListener() {}, removeEventListener() {}, execCommand: () => true,
};
const store = new Map();
const loaded = new Map();
globalThis.document = documentStub;
globalThis.window = globalThis;
// Node 24 起 navigator 为只读 getter，只能用 defineProperty 覆盖
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} }, language: "zh-CN" }, configurable: true });
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) });
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.__ModuleLoader__ = {
	load(descriptor) {
		loaded.set(descriptor.id, descriptor);
	},
};
const deps = new Set();
const fakeRequire = (id) => {
	deps.add(id);
	if (id === "react") {
		const react = { useState: (v) => [v, () => {}], useEffect() {}, useRef: (v) => ({ current: v }), useMemo: (f) => f(), useCallback: (f) => f, useSyncExternalStore: (s, g) => g(), useReducer: (r, i) => [i, () => {}], createContext: () => ({}), useContext: () => ({}), createElement: () => null, Fragment: "Fragment", default: null };
		return react;
	}
	if (id === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null, Fragment: "Fragment" };
	if (id === "zustand") return { create: () => () => ({ getState: () => ({}), subscribe: () => () => {} }) };
	if (id === "immer") return { produce: (base) => base };
	if (id === "semver") return { valid: () => null, gt: () => false, lt: () => false, coerce: () => null };
	return new Proxy({}, { get: (_t, key) => (typeof key === "string" && /^[A-Z]/.test(key) ? () => null : undefined) });
};
try {
	const factory = new Function("require", "module", "exports", "__ModuleLoader__", client.replace(/^/, ""));
	// bundle 是 IIFE，直接 eval 触发 load
	new Function("window", "document", "navigator", "localStorage", "fetch", "MutationObserver", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "__ModuleLoader__", "require", client)(
		globalThis, documentStub, globalThis.navigator, globalThis.localStorage, globalThis.fetch, globalThis.MutationObserver, globalThis.ResizeObserver, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame, globalThis.__ModuleLoader__, fakeRequire
	);
	ok("bundle 执行并调用 __ModuleLoader__.load", loaded.size === 1, `load 次数=${loaded.size}`);
	ok("注册的 id 正确", [...loaded.keys()][0] === EXPECT_ID, [...loaded.keys()][0]);
	const descriptor = [...loaded.values()][0];
	ok("factory 可用（typeof function）", typeof descriptor.factory === "function");
	ok("客户端补丁声明存在（cordis.patch 由 package.json dsh.bundle 提供）", pkg.dsh?.bundle?.patch === "./cordis.patch.yml", JSON.stringify(pkg.dsh?.bundle));
} catch (error) {
	ok("bundle 执行未抛错", false, error.message);
}

/* ---------- 5. 敏感信息 ---------- */
console.log("\n[5] 敏感信息扫描（公开仓库红线）");
const patterns = [
	["API key / token 字面量", /(?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}["']/i],
	["私钥块", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	["本机用户目录（任意用户名）", /[A-Z]:\\\\?Users\\\\?[A-Za-z0-9_.-]{3,}/i],
	["本机用户目录（拼接形式）", /Users.{0,3}\\\\?[A-Za-z0-9_.-]{3,}/i],
	["盘符绝对路径（C:\\ 或 D:\\ 等）", /["'`][A-Za-z]:\\\\/],
	["内网 IP", /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
	["邮箱地址", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
	["QQ / 微信 ID 痕迹", /(?:qq\.com|weixin|wechat)[^\s"'`]{0,24}(?:id|号)/i],
	["console.log 调试残留", /console\.log\(/],
];
const scanFiles = [...textFiles, "README.md", "README.zh-CN.md", "CHANGELOG.md", "CHANGELOG.zh-CN.md", "NOTICE", "LICENSE"].filter((f) => {
	try { return statSync(join(ROOT, f)).isFile(); } catch { return false; }
});
for (const [label, re] of patterns) {
	const hits = [];
	for (const file of scanFiles) {
		const text = read(file);
		const m = re.exec(text);
		if (!m) continue;
		// 版本号误判白名单：形如 "immer": "10.1.1" 的点分数字不是内网 IP
		if (label === "内网 IP" && /^\d+\.\d+\.\d+$/.test(m[0])) {
			const before = text.slice(Math.max(0, m.index - 40), m.index);
			// 命中值本身是三段点分数字，且前面是 "key": " 形式 → 依赖版本号而非 IP
			if (/["']?[A-Za-z@][\w@/.-]*["']?\s*:\s*["']$/.test(before)) continue;
		}
		hits.push(`${file}: ${JSON.stringify(m[0].slice(0, 48))}`);
	}
	// 白名单：仓库 URL / npm registry / 官方示例域名不算泄露
	const filtered = hits.filter((h) => !/github\.com|npmjs\.com|deepseek|huggingface|example\.com|apache\.org/.test(h));
	ok(label, filtered.length === 0, filtered.slice(0, 2).join(" | "));
}

console.log(`\n合计失败 ${failures} 项。`);
process.exit(failures === 0 ? 0 : 1);
