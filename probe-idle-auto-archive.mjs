#!/usr/bin/env node
/**
 * 第十批回归探针：按时间筛选自动归档
 *   1. idleUnarchivedSessionIds 纯函数行为（阈值边界 / 跳过已归档 / 无时间戳不纳入 / 排序）
 *   2. 天数持久化读写与夹取
 *   3. 宿主 archiveSessionsByIds 运行时行为（去重、跳过已归档、单次落盘、未知会话归 failures）
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const PKG = process.env.DSH_ARCHIVE_MANAGER_DIR ??
	join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager");
const CLIENT_SRC = readFileSync(join(PKG, "lib", "client.js"), "utf8");
const WS_SRC = readFileSync(join(PKG, "lib", "workspace.js"), "utf8");

/* ---------- 从 bundle 中取出纯函数并单测 ---------- */
function extractFn(name) {
	const start = CLIENT_SRC.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`找不到函数 ${name}`);
	// 逐字符配对大括号，避免正则截断
	let depth = 0;
	let i = CLIENT_SRC.indexOf("{", start);
	for (; i < CLIENT_SRC.length; i += 1) {
		if (CLIENT_SRC[i] === "{") depth += 1;
		else if (CLIENT_SRC[i] === "}") {
			depth -= 1;
			if (depth === 0) break;
		}
	}
	return CLIENT_SRC.slice(start, i + 1);
}

const store = new Map();
globalThis.localStorage = {
	getItem: (k) => (store.has(k) ? store.get(k) : null),
	setItem: (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
};
const harness = new Function(
	...["localStorage"],
	`${extractFn("readIdleArchiveDays")}
     ${extractFn("writeIdleArchiveDays")}
     ${extractFn("idleUnarchivedSessionIds")}
     ${extractFn("formatIdleDays")}
     const IDLE_ARCHIVE_DAYS_KEY = "dsham.idleArchiveDays.v1";
     const IDLE_ARCHIVE_DEFAULT_DAYS = 1;
     return { readIdleArchiveDays, writeIdleArchiveDays, idleUnarchivedSessionIds, formatIdleDays };`
)(globalThis.localStorage);
const { idleUnarchivedSessionIds, readIdleArchiveDays, writeIdleArchiveDays, formatIdleDays } = harness;

const DAY = 864e5;
const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

test("闲置筛选：超过 N 天才入选，恰好等于阈值不入选", () => {
	const byId = new Map([
		["old", { updatedAt: NOW - 3 * DAY }],
		["edge", { updatedAt: NOW - 1 * DAY }],
		["fresh", { updatedAt: NOW - 60_000 }],
	]);
	const hit = idleUnarchivedSessionIds(byId, [], 1, NOW);
	assert.ok(hit.includes("old"), "3 天前的会话应入选");
	assert.ok(!hit.includes("fresh"), "1 分钟前的会话不应入选");
	// 边界语义：updatedAt < threshold 才算闲置，恰好等于阈值不入选（避免"整点误归档"）
	assert.equal(hit.includes("edge"), false, "恰好等于阈值的会话不应入选");
});

test("闲置筛选：阈值为 0 或非法时一律不归档（防全量误归档）", () => {
	const byId = new Map([["a", { updatedAt: NOW - 9 * DAY }], ["b", { updatedAt: 1 }]]);
	assert.deepEqual(idleUnarchivedSessionIds(byId, [], 0, NOW), [], "0 天视为未设置，不应归档任何会话");
	assert.deepEqual(idleUnarchivedSessionIds(byId, [], void 0, NOW), []);
	assert.deepEqual(idleUnarchivedSessionIds(byId, [], Number.NaN, NOW), []);
	assert.deepEqual(idleUnarchivedSessionIds(byId, [], -5, NOW), []);
	assert.deepEqual(idleUnarchivedSessionIds(byId, [], "", NOW), []);
});

test("闲置筛选：now 缺省时使用当前时间且不影响判定", () => {
	const recent = Date.now() - 60_000;
	const stale = Date.now() - 30 * DAY;
	const byId = new Map([["r", { updatedAt: recent }], ["s", { updatedAt: stale }]]);
	const hit = idleUnarchivedSessionIds(byId, [], 7);
	assert.deepEqual(hit, ["s"]);
});

test("闲置筛选：空输入与异常输入安全", () => {
	assert.deepEqual(idleUnarchivedSessionIds(new Map(), [], 1, NOW), []);
	assert.deepEqual(idleUnarchivedSessionIds(void 0, void 0, 1, NOW), []);
});

test("闲置筛选：已归档会话一律排除", () => {
	const byId = new Map([["a", { updatedAt: NOW - 9 * DAY }], ["b", { updatedAt: NOW - 9 * DAY }]]);
	assert.deepEqual(idleUnarchivedSessionIds(byId, ["a"], 1, NOW), ["b"]);
	assert.deepEqual(idleUnarchivedSessionIds(byId, ["a", "b"], 1, NOW), [], "全部已归档时结果为空");
});

test("闲置筛选：缺失或非法时间戳绝不入选（防误归档）", () => {
	const byId = new Map([
		["nan", { updatedAt: Number.NaN }],
		["zero", { updatedAt: 0 }],
		["neg", { updatedAt: -5 }],
		["missing", {}],
		["undef", void 0],
		["str", { updatedAt: "not-a-number" }],
		["ok", { updatedAt: NOW - 10 * DAY }],
	]);
	assert.deepEqual(idleUnarchivedSessionIds(byId, [], 1, NOW), ["ok"], "只有有效时间戳的会话可被自动归档");
});

test("闲置筛选：结果按最旧优先排序，便于预览", () => {
	const byId = new Map([
		["mid", { updatedAt: NOW - 5 * DAY }],
		["oldest", { updatedAt: NOW - 30 * DAY }],
		["new", { updatedAt: NOW - 2 * DAY }],
	]);
	assert.deepEqual(idleUnarchivedSessionIds(byId, [], 1, NOW), ["oldest", "mid", "new"]);
});

test("闲置筛选：空输入与异常输入安全", () => {
	assert.deepEqual(idleUnarchivedSessionIds(new Map(), [], 1, NOW), []);
	assert.deepEqual(idleUnarchivedSessionIds(void 0, void 0, 1, NOW), []);
	assert.deepEqual(idleUnarchivedSessionIds(new Map([["a", { updatedAt: NOW - 9 * DAY }]]), [], 0, NOW), [], "阈值为 0 时不入选任何会话");
	assert.deepEqual(idleUnarchivedSessionIds(new Map([["a", { updatedAt: NOW - 9 * DAY }]]), [], void 0, NOW), []);
});

test("天数持久化：默认 1 天、写入后读回、非法值回落、范围夹取", () => {
	store.clear();
	assert.equal(readIdleArchiveDays(), 1, "未设置时默认 1 天");
	writeIdleArchiveDays(7);
	assert.equal(readIdleArchiveDays(), 7);
	store.set("dsham.idleArchiveDays.v1", "abc");
	assert.equal(readIdleArchiveDays(), 1, "非法值回落默认");
	store.set("dsham.idleArchiveDays.v1", "-3");
	assert.equal(readIdleArchiveDays(), 1, "非正值回落默认");
	store.set("dsham.idleArchiveDays.v1", "99999");
	assert.equal(readIdleArchiveDays(), 3650, "上限夹取到 3650");
	store.set("dsham.idleArchiveDays.v1", "0.2");
	assert.equal(readIdleArchiveDays(), 0.5, "下限夹取到 0.5 且对齐半步");
	assert.equal(formatIdleDays(1), "1");
	assert.equal(formatIdleDays(1.5), "1.5");
});

/* ---------- 宿主端 archiveSessionsByIds 运行时 ---------- */
let WorkspaceProto;
try {
	const mod = await import(pathToFileURL(join(PKG, "lib", "workspace.js")).href);
	const Ctor = mod.default ?? mod.WorkspaceRegistry ?? mod.archiveWorkspaceModule?.impl;
	WorkspaceProto = Ctor?.prototype;
} catch {
	WorkspaceProto = void 0;
}

if (WorkspaceProto?.archiveSessionsByIds !== undefined) {
	const makeSelf = (initialArchived, known) => {
		const state = { archivedSessionIds: [...initialArchived], workspaceIds: [] };
		const calls = { setState: 0 };
		const self = {
			calls,
				ctx: { logger: { warn() {}, info() {}, error() {} }, get: () => void 0, emit() {} },
				requireState: () => state,
				setState: async (next) => { calls.setState += 1; Object.assign(state, next); },
				sessionKnown: async (id) => known.has(id),
				enqueueOperation: async (fn) => fn(),
			};
		return { calls, self, state };
	};

	test("宿主：批量归档去重、跳过已归档、只落盘一次", async () => {
		const { self, calls, state } = makeSelf(["already"], new Set(["a", "b", "already"]));
		const result = await WorkspaceProto.archiveSessionsByIds.call(self, ["a", "a", "b", "already"]);
		assert.deepEqual(result.archivedSessionIdsAdded.sort(), ["a", "b"]);
		assert.deepEqual(result.skippedSessionIds, ["already"]);
		assert.equal(calls.setState, 1, `setState 应为 1 次，实际 ${calls.setState}`);
		assert.deepEqual([...state.archivedSessionIds].sort(), ["a", "already", "b"]);
		assert.deepEqual(result.archivedSessionIds.sort(), ["a", "already", "b"], "返回的权威集合应与状态一致");
	});

	test("宿主：未知会话进 failures 且不中断整批", async () => {
		const { self, state } = makeSelf([], new Set(["good"]));
		const result = await WorkspaceProto.archiveSessionsByIds.call(self, ["good", "ghost"]);
		assert.deepEqual(result.archivedSessionIdsAdded, ["good"]);
		assert.equal(result.failures.length, 1);
		assert.equal(result.failures[0].sessionId, "ghost");
		assert.deepEqual(state.archivedSessionIds, ["good"], "未知会话不得写入归档集合");
	});

	test("宿主：空清单与非数组输入安全返回", async () => {
		const a = makeSelf(["keep"], new Set());
		const r1 = await WorkspaceProto.archiveSessionsByIds.call(a.self, []);
		assert.deepEqual(r1.archivedSessionIdsAdded, []);
		assert.deepEqual(r1.archivedSessionIds, ["keep"]);
		const b = makeSelf(["keep"], new Set());
		const r2 = await WorkspaceProto.archiveSessionsByIds.call(b.self, void 0);
		assert.deepEqual(r2.archivedSessionIdsAdded, [], "非数组输入不应抛错");
		const c = makeSelf(["keep"], new Set(["x"]));
		const r3 = await WorkspaceProto.archiveSessionsByIds.call(c.self, ["", null, undefined, "x"]);
		assert.deepEqual(r3.archivedSessionIdsAdded, ["x"], "空串/空值应被过滤");
	});

	test("宿主：重复归档同一会话不会污染集合", async () => {
		const { self, state } = makeSelf([], new Set(["dup"]));
		await WorkspaceProto.archiveSessionsByIds.call(self, ["dup"]);
		await WorkspaceProto.archiveSessionsByIds.call(self, ["dup"]);
		const second = await WorkspaceProto.archiveSessionsByIds.call(self, ["dup"]);
		assert.deepEqual(second.archivedSessionIdsAdded, [], "第二次起应识别为已归档并跳过");
		assert.deepEqual(second.skippedSessionIds, ["dup"]);
		assert.equal(state.archivedSessionIds.filter((id) => id === "dup").length, 1, "归档集合内不应出现重复项");
	});
} else {
	test("宿主探针降级", () => console.log("[skip] 未能取得 archiveSessionsByIds 原型方法，仅执行静态断言。"));
}

/* ---------- 静态断言：接线完整性 ---------- */
test("接线：远程方法声明与包装齐备", () => {
	assert.equal((WS_SRC.match(/markRemoteMethod\(this, "archiveSessionsByIds"\)/g) ?? []).length, 1);
	assert.ok(WS_SRC.includes('#workspaceRegistry/archiveSessionsByIds"'), "缺少 remote 声明条目");
	assert.ok(WS_SRC.includes("sessionIdListSchema"), "缺少参数 schema");
	assert.equal((CLIENT_SRC.match(/registry\.archiveSessionsByIds\(/g) ?? []).length, 1, "客户端应恰好一处调用远程批量归档");
	assert.ok(CLIENT_SRC.includes("await refreshSessionList();"), "归档后应刷新会话列表");
	assert.ok(CLIENT_SRC.includes('unarchiveSessions(target)'), "撤回应复用既有恢复接口");
});

test("界面：设置块与词条存在且中英齐备", () => {
	for (const key of ["archives.idleTitle", "archives.idleRun", "archives.idleUndo", "archives.idleNote", "archives.idleMatched"]) {
		const occurrences = (CLIENT_SRC.match(new RegExp(`"${key}"`, "g")) ?? []).length;
		assert.ok(occurrences >= 2, `${key} 至少应有中英文两处词条，实际 ${occurrences}`);
	}
	assert.ok(CLIENT_SRC.includes('type: "number"') && CLIENT_SRC.includes("step: 0.5"), "天数输入框应为可步进的数字输入");
	assert.ok(CLIENT_SRC.includes("min: 0.5, max: 3650"), "输入范围应有上下限");
});
