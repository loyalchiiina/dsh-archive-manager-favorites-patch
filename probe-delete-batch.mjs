#!/usr/bin/env node
/**
 * 第九批回归探针：批量删除提速 + 归档标记合并落盘
 *
 * 用桩替换宿主服务（sessions / sessionPersistence / sessionProjectionCache / 状态存储），
 * 直接驱动 lib/workspace.js 的 deleteArchivedSessions，断言：
 *   1. whenIdle 整批只等一次（原版每会话一次）
 *   2. listStoredHeaders 整批只枚举一次（原版每父会话一次）
 *   3. setState 整批只写一次（原版每会话一次）
 *   4. deleted / skipped / failures 三类结果语义与原版一致
 *   5. 子代理级联仍能命中头部清单（证明 batch.warm() 生效）
 *   6. 转录目录确实被请求删除（每个目标一次）
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const PKG = process.env.DSH_ARCHIVE_MANAGER_DIR ??
  join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager");

// workspace.js 会 import 宿主包；这里用轻量桩拦截不了 import，因此只测已导出的类。
// 若模块加载需要真实宿主依赖，本探针自动跳过（不算失败）。
let WorkspaceRegistry;
try {
	const mod = await import(pathToFileURL(join(PKG, "lib", "workspace.js")).href);
	WorkspaceRegistry = mod.default ?? mod.WorkspaceRegistry ?? mod.archiveWorkspaceModule?.impl;
} catch (error) {
	console.log(`[skip] 无法直接加载 workspace.js（${error.code ?? error.message}），改用源码静态断言。`);
	WorkspaceRegistry = void 0;
}

const SOURCE = await import("node:fs").then((fs) => fs.readFileSync(join(PKG, "lib", "workspace.js"), "utf8"));

test("批量删除：三笔固定开销都降为整批一次", () => {
	// whenIdle 在批量入口出现一次，且不在逐会话路径里重复
	const batchBody = SOURCE.slice(SOURCE.indexOf("async deleteArchivedSessions(target)"), SOURCE.indexOf("async deleteSessionHeavy"));
	assert.equal((batchBody.match(/whenIdle/g) ?? []).length, 1, "whenIdle 应只在批量入口调用一次");
	assert.ok(!/for \(const sessionId of requestedSessionIds\)[\s\S]{0,200}?await this\.deleteSessionCore/.test(batchBody),
		"不应再有逐会话串行 deleteSessionCore 循环");
	assert.ok(/await batch\.warm\(\)/.test(batchBody), "必须预热磁盘头部清单，否则子代理会漏删");
	assert.ok(/await projCache\?\.whenIdle\?\.\(\);[\s\S]*await batch\.warm\(\)/.test(batchBody),
		"warm 必须在 whenIdle 之后、并行调度之前");
	const workersAt = batchBody.indexOf("const workers = Array.from");
	assert.ok(workersAt > batchBody.indexOf("await batch.warm()"), "并行调度必须晚于清单预热");
});

test("批量删除：归档标记合并为一次 setState", () => {
	const flushImpl = SOURCE.slice(SOURCE.indexOf("async flushDeferredArchiveState"), SOURCE.indexOf("async deleteDescendantsInBatch"));
	assert.ok(/new Set\(sessionIds\)/.test(flushImpl), "收尾应按集合一次性过滤");
	assert.equal((flushImpl.match(/await this\.setState/g) ?? []).length, 1, "setState 只调用一次");
	const batchBody = SOURCE.slice(SOURCE.indexOf("async deleteArchivedSessions(target)"), SOURCE.indexOf("async deleteSessionHeavy"));
	assert.ok(/await this\.flushDeferredArchiveState\(\[\.\.\.deletedSessionIds\]\)/.test(batchBody));
	// 重活阶段不得再各自写 state
	const heavy = SOURCE.slice(SOURCE.indexOf("async deleteSessionHeavy"), SOURCE.indexOf("async finishSessionDeletion"));
	assert.ok(!/this\.setState/.test(heavy), "deleteSessionHeavy 不应逐个写 state");
});

test("批量删除：限并发而非串行，且并发度保守", () => {
	const conc = /const CONCURRENCY = Math\.min\((\d+)/.exec(SOURCE);
	assert.ok(conc, "缺少并发度定义");
	const value = Number(conc[1]);
	assert.ok(value >= 2 && value <= 6, `并发度 ${value} 超出合理区间`);
	assert.ok(/Promise\.all\(workers\)/.test(SOURCE), "应等待全部 worker 完成再收尾");
});

test("批量删除：结果分类与错误处理语义保持", () => {
	const batchBody = SOURCE.slice(SOURCE.indexOf("async deleteArchivedSessions(target)"), SOURCE.indexOf("async deleteSessionHeavy"));
	assert.ok(/cleanupUnknownArchivedSession/.test(batchBody), "未知会话仍走陈旧项清理");
	assert.ok(/skippedSessionIds\.push/.test(batchBody));
	assert.ok(/failures\.push\(\{ sessionId, message/.test(batchBody));
	assert.ok(/return \{\s*requestedSessionIds,\s*deletedSessionIds,\s*skippedSessionIds,\s*failures\s*\};/.test(batchBody),
		"返回结构必须与原版一致，客户端依赖它");
});

test("批量删除：级联子代理复用共享清单", () => {
	const start = SOURCE.indexOf("async deleteDescendantsInBatch");
	assert.ok(start > 0, "找不到 deleteDescendantsInBatch");
	// 终点取下一个类成员声明，避免误用其它位置出现的同名调用
	let end = SOURCE.indexOf("\n  async ", start + 10);
	if (end === -1) end = SOURCE.length;
	const cascade = SOURCE.slice(start, end);
	assert.ok(/batch\.storedHeaders\(\)/.test(cascade), "级联应使用批量共享清单");
	assert.ok(!/await this\.listStoredHeaders\(\)/.test(cascade), "级联内部不应再各自全量扫盘");
	assert.ok(/origin === "subagent"/.test(cascade), "仍只对 subagent 头部做级联（fork 分支不得被删）");
});

/**
 * 行为级验证：不构造 Cordis 服务实例（其构造函数需要真实容器），
 * 而是直接在自制 this 上调用类原型上的批量删除方法。
 */
const Proto = WorkspaceRegistry?.prototype;

if (Proto?.deleteArchivedSessions !== undefined) {
	test("运行时：整批只付一次 whenIdle / listStoredHeaders / setState", async () => {
		const calls = { whenIdle: 0, listStoredHeaders: 0, setState: 0, rm: [] };
		const dir = await mkdtemp(join(tmpdir(), "delprobe-"));
		const ids = ["a", "b", "c"];
		const headers = ids.map((id) => ({ id, cwd: dir, parentSession: null, origin: "user" }));
		const state = { archivedSessionIds: [...ids], workspaceIds: [] };
		const self = {
			ctx: {
				logger: { warn() {}, info() {}, error() {} },
				emit() {},
				get(name) {
					if (name === "sessionProjectionCache") {
						return { whenIdle: async () => { calls.whenIdle += 1; }, delete: async () => {}, clearTombstone: () => {} };
					}
					if (name === "sessions") return { get: () => void 0, list: () => [] };
					return void 0;
				},
			},
			headers: new Map(),
			deletedIdentities: new Map(),
			requireState: () => state,
			setState: async (next) => { calls.setState += 1; Object.assign(state, next); },
			sessionKnown: async (id) => ids.includes(id),
			listStoredHeaders: async () => { calls.listStoredHeaders += 1; return headers; },
			removeTranscriptDirectory: async (id) => { calls.rm.push(id); },
			cleanSpill: async () => {},
			deleteDescendantsInBatch: async () => {},
			removeFromWorkspaceAccounts: async () => {},
			forgetIndexedSession: () => {},
			publishDeletedSession: () => {},
			publishColdSessionRemoval: async () => {},
			archivedSessionIdsForTarget: () => [...ids],
			// 绕过 enqueueOperation 的容器依赖，直接执行其回调
			enqueueOperation: async (fn) => fn(),
		};
		Object.assign(self, {
			deleteSessionHeavy: Proto.deleteSessionHeavy,
			finishSessionDeletion: Proto.finishSessionDeletion,
			flushDeferredArchiveState: Proto.flushDeferredArchiveState,
		});
		const result = await Proto.deleteArchivedSessions.call(self, { scope: "all" });
		assert.deepEqual([...result.deletedSessionIds].sort(), ids);
		assert.equal(result.skippedSessionIds.length, 0);
		assert.equal(result.failures.length, 0);
		assert.deepEqual([...result.requestedSessionIds].sort(), ids, "返回结构必须保持原版字段");
		assert.equal(calls.whenIdle, 1, `whenIdle 应为 1 次，实际 ${calls.whenIdle}`);
		assert.equal(calls.listStoredHeaders, 1, `listStoredHeaders 应为 1 次，实际 ${calls.listStoredHeaders}`);
		assert.equal(calls.setState, 1, `setState 应为 1 次，实际 ${calls.setState}`);
		assert.deepEqual([...calls.rm].sort(), ids, "每个会话都应请求删除转录目录");
		assert.deepEqual(state.archivedSessionIds, [], "归档标记应被批量清除");
		await rm(dir, { recursive: true, force: true });
	});

	test("运行时：结果三类字段互斥且失败项带原因", async () => {
		const settled = [];
		const self = {
			ctx: { logger: { warn() {} }, get: () => void 0 },
			headers: new Map(),
			deletedIdentities: new Map(),
			requireState: () => ({ archivedSessionIds: ["ok", "boom"], workspaceIds: [] }),
			setState: async () => {},
			sessionKnown: async () => true,
			listStoredHeaders: async () => [],
			enqueueOperation: async (fn) => fn(),
			archivedSessionIdsForTarget: () => ["ok", "boom"],
			deleteSessionHeavy: Proto.deleteSessionHeavy,
			finishSessionDeletion: async (id) => { settled.push(id); },
			flushDeferredArchiveState: Proto.flushDeferredArchiveState,
			cleanupUnknownArchivedSession: async () => {},
			// 只有一个会话会在重活阶段失败
			removeTranscriptDirectory: async (id) => { if (id === "boom") throw new Error("disk busy"); },
			cleanSpill: async () => {},
			deleteDescendantsInBatch: async () => {},
		};
		const result = await Proto.deleteArchivedSessions.call(self, { scope: "all" });
		assert.deepEqual(result.deletedSessionIds, ["ok"]);
		assert.equal(result.skippedSessionIds.length, 0);
		assert.equal(result.failures.length, 1);
		assert.equal(result.failures[0].sessionId, "boom");
		assert.match(result.failures[0].message, /disk busy/);
		assert.deepEqual(settled, ["ok"], "只有成功删除的会话才进入收尾记账");
		// 三类结果不得重叠
		const overlap = result.deletedSessionIds.filter((id) => result.skippedSessionIds.includes(id) || result.failures.some((f) => f.sessionId === id));
		assert.deepEqual(overlap, [], "同一会话不能同时出现在成功与失败集合中");
	});
} else {
	test("运行时探针跳过说明", () => {
		console.log("[skip] 未能取得 WorkspaceRegistry.prototype，仅执行静态断言。");
	});
}
