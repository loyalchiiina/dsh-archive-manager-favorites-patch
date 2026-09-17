// 计算可安全恢复的集合（修正版）。
//
// 关键事实（已实测确认）：
//   - workspace.json 里的会话 id **自带 `session-` 前缀**，形如 `session-<uuid>`
//   - ~/.dsh/sessions/<encoded-cwd>/<uuid>/ 的目录名是**裸 uuid**
//   因此比对必须统一成裸 uuid，否则会得出「交集为 0」的错误结论。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STORE = join(homedir(), ".dsh", "storages");
const SESSIONS = join(homedir(), ".dsh", "sessions");
const BACKUP_FILE = process.argv[2] ?? "workspace.json.bak-20260916-105745";

const bare = (id) => String(id).replace(/^session-/, "");
const load = (name) => JSON.parse(readFileSync(join(STORE, name), "utf8").replace(/^\ufeff/, ""));

const bak = load(BACKUP_FILE);
const cur = load("workspace.json");

// 磁盘现存：uuid -> 所属 cwd 目录名
const onDisk = new Map();
(function walk(dir, depth) {
	if (depth > 2) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const full = join(dir, entry.name);
		const rel = entry.name.replace(/^session-/, "");
		// 顶层是 encoded-cwd，其子目录才是会话目录
		if (depth === 1 && /^[0-9a-f]{8}-/i.test(rel)) onDisk.set(rel.toLowerCase(), dir.split(/[\\/]/).pop());
		else walk(full, depth + 1);
	}
})(SESSIONS, 0);

const tableSessions = (state) => {
	const byWorkspace = new Map();
	for (const [key, value] of Object.entries(state.tables?.workspaces ?? {})) {
		const rec = value?.record ?? value ?? {};
		byWorkspace.set(key, (rec.sessionIds ?? []).map(String));
	}
	return byWorkspace;
};

const bakArchived = (bak.global?.archivedSessionIds ?? []).map(String);
const curArchived = (cur.global?.archivedSessionIds ?? []).map(String);
const bakTable = tableSessions(bak);
const curTable = tableSessions(cur);

const bakAccounted = new Set([...bakTable.values()].flat().map(bare));
const curAccounted = new Set([...curTable.values()].flat().map(bare));

console.log(`备份文件              = ${BACKUP_FILE}`);
console.log(`磁盘现存会话          = ${onDisk.size}`);
console.log(`备份归档 / 当前归档   = ${bakArchived.length} / ${curArchived.length}`);
console.log(`备份记账 / 当前记账   = ${bakAccounted.size} / ${curAccounted.size}`);

const recoverableArchived = bakArchived.filter((id) => onDisk.has(bare(id)));
const recoverableAccounted = [...bakAccounted].filter((id) => onDisk.has(bare(id)) && !curAccounted.has(bare(id)));

console.log("\n=== 可安全恢复（备份有记录 ∩ 磁盘仍有转录）===");
console.log(`归档标记可恢复 = ${recoverableArchived.length}`);
console.log(`记账可补回     = ${recoverableAccounted.length}`);

const archivedStillOnDiskButLost = recoverableArchived.filter((id) => !curAccounted.has(bare(id)));
console.log(`其中既无归档标记也无记账 = ${archivedStillOnDiskButLost.length}`);

console.log("\n=== 样例（前 12 个可恢复归档）===");
for (const id of recoverableArchived.slice(0, 12)) console.log(`  ${id}  @${onDisk.get(bare(id))}`);

// 输出机器可读结果，供写回脚本使用
const out = {
	backupFile: BACKUP_FILE,
	recoverableArchived,
	recoverableAccounted,
	tableOf: Object.fromEntries(bakTable),
	curTableOf: Object.fromEntries(curTable),
};
writeJson(out);

function writeJson(obj) {
	const { writeFileSync } = require_fs();
	writeFileSync(join(import.meta.dirname, "restore-plan.json"), JSON.stringify(obj, null, 2), "utf8");
	console.log(`\n计划已写出 restore-plan.json（${recoverableArchived.length} 条归档待恢复）`);
}
function require_fs() { return fsModule; }
import * as fsModule from "node:fs";
