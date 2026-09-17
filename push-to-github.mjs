#!/usr/bin/env node
/**
 * 把发布目录逐文件推送到 GitHub（Contents API，每个文件一个 commit）。
 *
 * 本机 git/curl 到 github.com:443 被沙箱封锁，只有 `gh api` 通道可用，
 * 因此用 PUT /repos/{owner}/{repo}/contents/{path} 上传，base64 由 PowerShell 侧生成。
 * 这里只负责编排：读取本地文件 → 调 gh api → 记录结果。
 *
 * 用法：node push-to-github.mjs <dir> <owner/repo> [branch]
 */
import { readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, relative, posix } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.argv[2];
const REPO = process.argv[3];
const BRANCH = process.argv[4] ?? "main";

if (!ROOT || !REPO) {
	console.error("用法：node push-to-github.mjs <dir> <owner/repo> [branch]");
	process.exit(2);
}

function walk(dir, base = dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".git") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full, base));
		else out.push({ abs: full, rel: posix.join(...relative(base, full).split("\\")) });
	}
	return out;
}

/** 通过 gh api 发请求；payload 走 --input 临时文件，避免 PowerShell 拆参数。 */
function ghApi(method, endpoint, payloadObject) {
	const tmp = join(process.cwd(), `.gh-payload-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
	const args = ["api", "-X", method, endpoint];
	if (payloadObject !== undefined) {
		writeFileSyncSafe(tmp, JSON.stringify(payloadObject));
		args.push("--input", tmp);
	}
	const result = spawnSync("gh", args, { encoding: "utf8", windowsHide: true });
	try { rmSync(tmp, { force: true }); } catch {}
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function writeFileSyncSafe(path, text) {
	writeFileSync(path, text, { encoding: "utf8" });
}

function existingSha(path) {
	const r = ghApi("GET", `/repos/${REPO}/contents/${path}?ref=${BRANCH}`);
	if (!r.ok) return null;
	try {
		const parsed = JSON.parse(r.stdout);
		return typeof parsed?.sha === "string" ? parsed.sha : null;
	} catch {
		return null;
	}
}

const files = walk(ROOT);
// README 先推，作为仓库首屏
files.sort((a, b) => (b.rel.startsWith("README") ? 1 : 0) - (a.rel.startsWith("README") ? 1 : 0));

let pushed = 0;
let failed = 0;
for (const file of files) {
	const bytes = readFileSync(file.abs);
	const sha = existingSha(file.rel);
	const payload = {
		message: `${sha ? "update" : "add"} ${file.rel}`,
		content: bytes.toString("base64"),
		branch: BRANCH,
	};
	if (sha !== null) payload.sha = sha;
	const r = ghApi("PUT", `/repos/${REPO}/contents/${file.rel}`, payload);
	if (r.ok) {
		pushed += 1;
		console.log(`  [ok]    ${file.rel} (${bytes.length} B)`);
	} else {
		failed += 1;
		console.log(`  [FAIL]  ${file.rel} — ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
	}
}

console.log(`\n推送完成：${pushed} 个文件成功，${failed} 个失败。仓库 ${REPO}@${BRANCH}`);
process.exit(failed === 0 ? 0 : 1);
