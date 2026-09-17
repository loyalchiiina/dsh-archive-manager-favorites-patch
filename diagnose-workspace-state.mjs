// 只读诊断：对比 workspace.json 当前与备份的结构差异，判断误操作影响面。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STORE = join(homedir(), ".dsh", "storages");
const SESSIONS = join(homedir(), ".dsh", "sessions");

const load = (name) => JSON.parse(readFileSync(join(STORE, name), "utf8").replace(/^\ufeff/, ""));

const files = [
	"workspace.json",
	"workspace.json.bak-20260916-104259",
	"workspace.json.bak-20260916-105745",
];

const parsed = new Map();
for (const file of files) {
	const o = load(file);
	const wsIds = o.global?.workspaceIds ?? [];
	const archived = o.global?.archivedSessionIds ?? [];
	const tableKeys = Object.keys(o.tables?.workspaces ?? {});
	const perWorkspace = tableKeys.map((k) => {
		const rec = o.tables.workspaces[k]?.record ?? o.tables.workspaces[k] ?? {};
		return { key: k, sessions: (rec.sessionIds ?? []).length };
	});
	parsed.set(file, { o, wsIds, archived, tableKeys, perWorkspace });
	console.log(`\n=== ${file} ===`);
	console.log(`  mtime            = ${statSync(join(STORE, file)).mtime.toISOString()}`);
	console.log(`  workspaceIds     = ${wsIds.length}`);
	console.log(`  archivedSessionIds = ${archived.length}`);
	console.log(`  tables.workspaces keys = ${tableKeys.length}`);
	for (const item of perWorkspace) console.log(`    - ${item.key}: sessionIds=${item.sessions}`);
}

const cur = parsed.get("workspace.json");
const bak = parsed.get("workspace.json.bak-20260916-105745");
console.log("\n=== 差异 ===");
console.log(`归档集合：${bak.archived.length} -> ${cur.archived.length}`);
console.log(`工作区表：${bak.tableKeys.length} -> ${cur.tableKeys.length}`);
const addedTable = cur.tableKeys.filter((k) => !bak.tableKeys.includes(k));
const removedTable = bak.tableKeys.filter((k) => !cur.tableKeys.includes(k));
console.log(`表新增 key = ${addedTable.length ? addedTable.join(",") : "无"}`);
console.log(`表移除 key = ${removedTable.length ? removedTable.join(",") : "无"}`);

// 会话目录盘点（递归找 session-*）
const dirIds = new Set();
(function walk(dir, depth) {
	if (depth > 3) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const full = join(dir, entry.name);
		if (entry.name.startsWith("session-")) dirIds.add(entry.name.slice("session-".length));
		else walk(full, depth + 1);
	}
})(SESSIONS, 0);
console.log(`\n磁盘上实际存在的会话 id 数 = ${dirIds.size}`);
const bakArchivedOnDisk = bak.archived.filter((id) => dirIds.has(id));
console.log(`备份归档中仍在磁盘的 = ${bakArchivedOnDisk.length} / ${bak.archived.length}`);
const curAll = new Set([...(cur.o.global?.archivedSessionIds ?? [])]);
console.log(`当前归档数 = ${curAll.size}`);

// 备份里被归档、但当前不在任何 workspace 记账中的数量（用于评估还原影响）
const accounted = new Set();
for (const k of bak.tableKeys) {
	const rec = bak.o.tables.workspaces[k]?.record ?? bak.o.tables.workspaces[k] ?? {};
	for (const id of rec.sessionIds ?? []) accounted.add(id);
}
console.log(`备份中被工作区记账的会话数 = ${accounted.size}`);
console.log(`备份归档且被记账 = ${bak.archived.filter((id) => accounted.has(id)).length}`);
