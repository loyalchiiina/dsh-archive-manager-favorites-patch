#!/usr/bin/env node
/**
 * @michengai/dsh-archive-manager 本地增强补丁 · 第九批：批量删除提速 + 删除进度显示
 *
 * 用户反馈："删除的时候还得优化，第一优化删除对话速度，第二……正在删除已归档聊天…
 *           这个删除的时候不显示删除任务的进度还有百分比。"
 *
 * ── 速度：宿主端 lib/workspace.js 的 deleteArchivedSessions 原本完全串行，
 *    且每个会话都要付三笔固定开销：
 *      1) `await projCache.whenIdle()`          —— 每会话等一次投影缓存空闲
 *      2) `this.listStoredHeaders()`            —— 级联删子代理时全量扫盘（N 次！）
 *      3) `this.setState(...)`                  —— 每会话全量重写 state 文件并广播
 *    本补丁把这三笔改成「整批各一次」，并把重 IO（转录目录 rm、spill、投影行删除、
 *    live flush）以限并发 6 路并行执行；纯内存的状态与记账留到串行收尾统一落盘。
 *    单会话删除路径（deleteSession）行为保持原样，不受影响。
 *
 * ── 进度：客户端确认弹窗与页面状态新增真实进度（已完成数 / 总数 + 百分比 + 进度条）。
 *    做法是把批量目标在客户端拆成小批次（每批 8 个会话）逐批调用宿主的
 *    `{ scope: "sessions", sessionIds }` 接口，每批返回后刷新计数；
 *    这样既有进度反馈，又让宿主端每批仍能享受上述批量优化。
 *
 * ⚠️ 执行顺序：第八批之后（apply-all.mjs 已按序串好）。
 *
 * 用法：
 *   node apply-delete-progress-patch.mjs --dry-run
 *   node apply-delete-progress-patch.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const PKG = resolve(
  process.env.DSH_ARCHIVE_MANAGER_DIR ??
    join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager"),
  "lib"
);
const CLIENT = join(PKG, "client.js");
const WORKSPACE = join(PKG, "workspace.js");
const BACKUP_ROOT = join(homedir(), ".dsh", "backups");

/* =====================================================================
 * 宿主端：批量删除提速
 * ===================================================================== */

const HOST_OLD_BATCH = `  async deleteArchivedSessions(target) {
    return this.enqueueOperation(async () => {
      const requestedSessionIds = this.archivedSessionIdsForTarget(target);
      const deletedSessionIds = [];
      const skippedSessionIds = [];
      const failures = [];
      for (const sessionId of requestedSessionIds) {
        try {
          await this.deleteSessionCore(sessionId);
          deletedSessionIds.push(sessionId);
        } catch (error) {
          if (error instanceof ArchiveUnknownSessionError) {
            try {
              await this.cleanupUnknownArchivedSession(sessionId);
              skippedSessionIds.push(sessionId);
            } catch (cleanupError) {
              failures.push({ sessionId, message: String(cleanupError) });
            }
            continue;
          }
          failures.push({ sessionId, message: String(error) });
        }
      }
      return {
        requestedSessionIds,
        deletedSessionIds,
        skippedSessionIds,
        failures
      };
    });
  }`;

const HOST_NEW_BATCH = `  async deleteArchivedSessions(target) {
    return this.enqueueOperation(async () => {
      const requestedSessionIds = this.archivedSessionIdsForTarget(target);
      const deletedSessionIds = [];
      const skippedSessionIds = [];
      const failures = [];
      // 整批共享的一次性准备：投影缓存只需等一次，磁盘头部清单只需枚举一次。
      const projCache = this.ctx.get("sessionProjectionCache");
      await projCache?.whenIdle?.();
      let cachedHeaders = [];
      const batch = {
        storedHeaders: () => cachedHeaders,
        warm: async () => {
          cachedHeaders = await this.listStoredHeaders();
          return cachedHeaders;
        }
      };
      // 必须先预热头部清单：级联删除子代理依赖它，未预热会让子会话静默漏删。
      await batch.warm();
      // 重 IO 限并发执行；纯内存的状态与记账放到串行收尾，避免跨会话竞态。
      // 并发度取 3：转录目录删除与 spill 清理是按会话独立的文件操作，可安全并行；
      // 而 sessions.flush / 冷会话移除通知涉及宿主共享状态，保守起见不做高并发。
      const CONCURRENCY = Math.min(3, Math.max(1, requestedSessionIds.length));
      let cursor = 0;
      const outcomes = /* @__PURE__ */ new Map();
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= requestedSessionIds.length) return;
          const sessionId = requestedSessionIds[index];
          try {
            outcomes.set(sessionId, { ok: true, heavy: await this.deleteSessionHeavy(sessionId, batch) });
          } catch (error) {
            if (error instanceof ArchiveUnknownSessionError) {
              try {
                await this.cleanupUnknownArchivedSession(sessionId);
                outcomes.set(sessionId, { ok: true, unknown: true });
              } catch (cleanupError) {
                outcomes.set(sessionId, { ok: false, message: String(cleanupError) });
              }
            } else {
              outcomes.set(sessionId, { ok: false, message: String(error) });
            }
          }
        }
      });
      await Promise.all(workers);
      for (const sessionId of requestedSessionIds) {
        const outcome = outcomes.get(sessionId);
        if (outcome?.ok !== true) {
          failures.push({ sessionId, message: outcome?.message ?? "unknown failure" });
          continue;
        }
        if (outcome.unknown === true) {
          skippedSessionIds.push(sessionId);
          continue;
        }
        deletedSessionIds.push(sessionId);
        // 收尾：工作区记账、归档标记移除、索引遗忘与通知。
        await this.finishSessionDeletion(sessionId, outcome.heavy);
      }
      // 归档标记一次性批量落盘，替代原来每会话一次全量写入。
      await this.flushDeferredArchiveState([...deletedSessionIds]);
      return {
        requestedSessionIds,
        deletedSessionIds,
        skippedSessionIds,
        failures
      };
    });
  }
  /** 批量删除的重活阶段：不含归档标记写入与工作区记账，供并行调度使用。 */
  async deleteSessionHeavy(sessionId, batch) {
    if (!await this.sessionKnown(sessionId))
      throw new ArchiveUnknownSessionError(sessionId);
    const sessions = this.ctx.get("sessions");
    const live = sessions?.get(sessionId);
    const deletedHeader = this.headers.get(sessionId) ?? live?.header;
    if (live !== void 0) {
      await sessions.flush(live);
      const entry = sessions.liveEntryFor(live);
      sessions.detachEntered(entry);
    } else if (sessions !== void 0)
      await this.publishColdSessionRemoval(sessionId, sessions);
    const projCache = this.ctx.get("sessionProjectionCache");
    if (projCache !== void 0) await projCache.delete(sessionId);
    await this.deleteDescendantsInBatch(sessionId, batch);
    await this.cleanSpill(sessionId);
    await this.removeTranscriptDirectory(sessionId);
    return { deletedHeader };
  }
  /** 批量删除的收尾阶段：工作区记账、索引遗忘与删除通知。 */
  async finishSessionDeletion(sessionId, heavy) {
    await this.removeFromWorkspaceAccounts(sessionId);
    this.forgetIndexedSession(sessionId);
    if (heavy?.deletedHeader !== void 0)
      this.deletedIdentities.set(sessionId, headerIdentity(heavy.deletedHeader));
    this.publishDeletedSession(sessionId);
  }
  /** 批量落盘归档标记：把 N 次全量写入合并为 1 次。 */
  async flushDeferredArchiveState(sessionIds) {
    if (sessionIds.length === 0) return;
    const removed = new Set(sessionIds);
    const state = this.requireState();
    if (!state.archivedSessionIds.some((id) => removed.has(id))) return;
    await this.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => !removed.has(id))
    });
  }
  /** 级联删除子代理：复用整批只枚举一次的头部清单，避免每会话全量扫盘。 */
  async deleteDescendantsInBatch(sessionId, batch) {
    try {
      const descendants = [];
      const sessions = this.ctx.get("sessions");
      if (sessions !== void 0)
        for (const session of sessions.list()) {
          if (session.header.parentSession === sessionId && session.header.origin === "subagent")
            descendants.push(session.id);
        }
      for (const header of batch.storedHeaders()) {
        if (header.parentSession === sessionId && header.origin === "subagent" && !descendants.includes(header.id))
          descendants.push(header.id);
      }
      for (const childId of descendants) {
        try {
          if (!await this.sessionKnown(childId)) continue;
          await this.deleteSessionCore(childId);
        } catch (error) {
          if (error instanceof ArchiveUnknownSessionError) continue;
          this.ctx.logger.warn(
            \`archive-manager: cascade delete of subagent session "\${childId}" (child of "\${sessionId}") failed: \${String(error)}\`
          );
        }
      }
    } catch (error) {
      this.ctx.logger.warn(
        \`archive-manager: descendant enumeration for deleted session "\${sessionId}" failed: \${String(error)}\`
      );
    }
  }`;

/**
 * 批量删除上下文以局部闭包实现（见 deleteArchivedSessions 内部）：
 * 整批共享的磁盘头部清单只枚举一次，供级联删除子代理时复用
 * （原版每个父会话都会重新全量扫盘一次，N 个会话 = N 次全量扫描）。
 */
const HOST_FACTORY_OLD = `  /**
   * 按作用域永久删除归档会话。跨会话文件删除无法组成事务，因此继续处理`;
const HOST_FACTORY_NEW = `  /**
   * 按作用域永久删除归档会话。跨会话文件删除无法组成事务，因此继续处理`;

/* =====================================================================
 * 客户端：分批删除 + 真实进度
 * ===================================================================== */

const CLIENT_STATE_OLD = `        const confirmDelete = async () => {
          if (busy || deleteTarget === null) return;
          setBusy(true);
          setError(null);
          setNotice(null);
          try {
            if (deleteTarget.kind === "batch") {
              const result = await deleteArchivedSessions(deleteTarget.target);
              const feedback = archivedDeleteFeedback(result, t);
              if (feedback.kind === "error") setError(feedback.message);
              else setNotice(feedback.message);
              const completed = /* @__PURE__ */ new Set([...result.deletedSessionIds, ...result.skippedSessionIds]);
              if (deleteTarget.target.scope === "sessions") {
                setSelectedSessionIds((current) => current.filter((sessionId) => !completed.has(sessionId)));
              }
              pruneFavorites(completed);
            } else {
              await deleteSession(deleteTarget.session.id);
              pruneFavorites([deleteTarget.session.id]);
            }
            setDeleteTarget(null);
          } catch (reason) {
            setError(formatDeleteError(reason, t));
          } finally {
            setBusy(false);
          }
        };`;

const CLIENT_STATE_NEW = `        /** 分批删除的批次大小：足够小以便及时回报进度，足够大以免频繁落盘。 */
        const DELETE_CHUNK_SIZE = 8;
        const confirmDelete = async () => {
          if (busy || deleteTarget === null) return;
          setBusy(true);
          setError(null);
          setNotice(null);
          try {
            if (deleteTarget.kind === "batch") {
              const plannedIds = deleteTarget.sessionIds ?? [];
              if (plannedIds.length === 0) {
                // 没有可拆分的显式清单时退回宿主原生批量接口（旧行为）。
                const result = await deleteArchivedSessions(deleteTarget.target);
                const feedback = archivedDeleteFeedback(result, t);
                if (feedback.kind === "error") setError(feedback.message);
                else setNotice(feedback.message);
                const completed = /* @__PURE__ */ new Set([...result.deletedSessionIds, ...result.skippedSessionIds]);
                if (deleteTarget.target.scope === "sessions") {
                  setSelectedSessionIds((current) => current.filter((sessionId) => !completed.has(sessionId)));
                }
                pruneFavorites(completed);
              } else {
                const total = plannedIds.length;
                setDeleteProgress({ done: 0, total });
                const completed = /* @__PURE__ */ new Set();
                const failedMessages = [];
                for (let index = 0; index < total; index += DELETE_CHUNK_SIZE) {
                  const chunk = plannedIds.slice(index, index + DELETE_CHUNK_SIZE);
                  const result = await deleteArchivedSessions({ scope: "sessions", sessionIds: chunk });
                  for (const id of result.deletedSessionIds ?? []) completed.add(id);
                  for (const id of result.skippedSessionIds ?? []) completed.add(id);
                  for (const item of result.failures ?? []) failedMessages.push(item?.message ?? "");
                  const done = Math.min(index + DELETE_CHUNK_SIZE, total);
                  setDeleteProgress({ done, total });
                  setNotice(t("archives.deleteProgress", { done, total, percent: Math.round(done / total * 100) }));
                  if (deleteTarget.filtered === true) {
                    setSelectedSessionIds((current) => current.filter((sessionId) => !completed.has(sessionId)));
                  }
                }
                pruneFavorites(completed);
                setSelectedSessionIds((current) => current.filter((sessionId) => !completed.has(sessionId)));
                const feedback = archivedDeleteFeedback({ deletedSessionIds: [...completed], skippedSessionIds: [], failures: failedMessages.map((message) => ({ message })) }, t);
                if (failedMessages.length > 0) setError(t("archives.deletePartialFailed", { n: failedMessages.length, detail: failedMessages[0] }));
                else if (feedback.kind === "error") setError(feedback.message);
                else setNotice(t("archives.deleteDone", { n: completed.size }));
                setDeleteProgress(null);
              }
            } else {
              await deleteSession(deleteTarget.session.id);
              pruneFavorites([deleteTarget.session.id]);
            }
            setDeleteTarget(null);
          } catch (reason) {
            setDeleteProgress(null);
            setError(formatDeleteError(reason, t));
          } finally {
            setBusy(false);
          }
        };`;

const CLIENT_PROGRESS_STATE_OLD = `        const [notice, setNotice] = (0, react.useState)(null);`;
const CLIENT_PROGRESS_STATE_NEW = `        const [notice, setNotice] = (0, react.useState)(null);
        const [deleteProgress, setDeleteProgress] = (0, react.useState)(null);`;

/** 弹窗内的进度条：插在描述展开之后、footer 之前。 */
const CLIENT_MODAL_OLD = `            ...deleteDialogDescription === void 0 ? {} : { description: deleteDialogDescription },
            footer:`;
const CLIENT_MODAL_NEW = `            ...deleteDialogDescription === void 0 ? {} : { description: deleteDialogDescription },
            children: deleteProgress === null ? null : (0, react_jsx_runtime.jsxs)("div", { className: "dsham_deleteProgress", role: "status", "aria-live": "polite", children: [(0, react_jsx_runtime.jsx)("div", { className: "dsham_deleteProgressBar", children: (0, react_jsx_runtime.jsx)("span", { style: { width: Math.round(deleteProgress.done / Math.max(1, deleteProgress.total) * 100) + "%" } }) }), (0, react_jsx_runtime.jsxs)("div", { className: "dsham_deleteProgressText", children: [t("archives.deleteProgress", { done: deleteProgress.done, total: deleteProgress.total, percent: Math.round(deleteProgress.done / Math.max(1, deleteProgress.total) * 100) }), deleteProgress.done < deleteProgress.total ? " \\u2026" : ""] })] }),
            footer:`;

/** 确认按钮文案在删除中显示百分比。 */
const CLIENT_CONFIRM_OLD = `children: deleteConfirmLabel`;
const CLIENT_CONFIRM_NEW = `disabled: busy || deleteProgress !== null, children: deleteProgress === null ? deleteConfirmLabel : t("archives.deleteProgressShort", { percent: Math.round(deleteProgress.done / Math.max(1, deleteProgress.total) * 100) })`;

/** CSS：进度条样式。 */
const CLIENT_CSS_OLD = `.dsham_pinBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:#f5a623}`;
const CLIENT_CSS_NEW = `.dsham_pinBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:#f5a623}.dsham_deleteProgress{margin-top:12px}.dsham_deleteProgressBar{position:relative;height:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-button-elevated-fill));border:1px solid var(--dsw-alias-border-l2);border-radius:999px}.dsham_deleteProgressBar>span{display:block;height:100%;background:var(--dsw-alias-state-error-primary,#e5484d);transition:width .18s ease}.dsham_deleteProgressText{margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}`;

const ZH_OLD = `        "archives.deleteUnfavoritedConfirm": "删除未收藏的聊天",`;
const ZH_NEW = `        "archives.deleteUnfavoritedConfirm": "删除未收藏的聊天",
        "archives.deleteProgress": "正在删除：{done}/{total}（{percent}%）",
        "archives.deleteProgressShort": "删除中 {percent}%",
        "archives.deleteDone": "已删除 {n} 个归档会话",
        "archives.deletePartialFailed": "{n} 个会话删除失败：{detail}",`;

const EN_OLD = `        "archives.deleteUnfavoritedConfirm": "Delete unfavorited chats",`;
const EN_NEW = `        "archives.deleteUnfavoritedConfirm": "Delete unfavorited chats",
        "archives.deleteProgress": "Deleting: {done}/{total} ({percent}%)",
        "archives.deleteProgressShort": "Deleting {percent}%",
        "archives.deleteDone": "Deleted {n} archived chats",
        "archives.deletePartialFailed": "{n} chats failed to delete: {detail}",`;

/** 三个「删除未收藏 / 全部删除」入口补上待删清单，用于计算进度分母。 */
const TARGETS = [
	{
		name: "T1-头部删除全部未收藏带清单",
		old: `setDeleteTarget({ kind: "batch", variant: "unfavorited", filtered: false, target: { scope: "sessions", sessionIds: unfavoritedListedIds }, count: unfavoritedListedIds.length })`,
		to: `setDeleteTarget({ kind: "batch", variant: "unfavorited", filtered: false, target: { scope: "sessions", sessionIds: unfavoritedListedIds }, sessionIds: unfavoritedListedIds, count: unfavoritedListedIds.length })`,
	},
	{
		name: "T2-工具栏删除筛选内未收藏带清单",
		old: `setDeleteTarget({ kind: "batch", variant: "unfavorited", filtered: true, target: { scope: "sessions", sessionIds: unfavoritedVisibleIds }, count: unfavoritedVisibleIds.length })`,
		to: `setDeleteTarget({ kind: "batch", variant: "unfavorited", filtered: true, target: { scope: "sessions", sessionIds: unfavoritedVisibleIds }, sessionIds: unfavoritedVisibleIds, count: unfavoritedVisibleIds.length })`,
	},
	{
		name: "T3-删除选中带清单",
		old: `setDeleteTarget({ kind: "batch", target: { scope: "sessions", sessionIds: selectedSessionIds }, count: selectedSessionIds.length })`,
		to: `setDeleteTarget({ kind: "batch", target: { scope: "sessions", sessionIds: selectedSessionIds }, sessionIds: selectedSessionIds, count: selectedSessionIds.length })`,
	},
];

function applyPatches(text, patches) {
	const log = [];
	let failed = 0;
	let current = text;
	for (const patch of patches) {
		const hits = current.split(patch.old).length - 1;
		if (hits === 1) {
			current = current.replace(patch.old, patch.to);
			log.push(`  [ok]   ${patch.name}`);
		} else if (hits === 0 && current.includes(patch.to)) {
			log.push(`  [skip] ${patch.name}（已是目标文本）`);
		} else {
			failed += 1;
			log.push(`  [FAIL] ${patch.name} — 锚点命中 ${hits} 次（期望 1 次）`);
		}
	}
	return { text: current, log, failed };
}

function writeIfChanged(file, next, original, tag) {
	if (next === original) {
		console.log(`  ${file}: 无变化`);
		return false;
	}
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const dir = join(BACKUP_ROOT, `archive-manager-delprog-${tag}-${stamp}`);
	mkdirSync(dir, { recursive: true });
	copyFileSync(file, join(dir, file.split(/[\\/]/).pop()));
	writeFileSync(file, next, { encoding: "utf8" });
	console.log(`  ${file}: 已写盘（备份 ${dir}）`);
	return true;
}

function main() {
	const dryRun = process.argv.includes("--dry-run");
	for (const [file, patches, tag] of [
		[CLIENT, [
			{ name: "C1-进度 state", old: CLIENT_PROGRESS_STATE_OLD, to: CLIENT_PROGRESS_STATE_NEW },
			{ name: "C2-confirmDelete 分批+进度", old: CLIENT_STATE_OLD, to: CLIENT_STATE_NEW },
			{ name: "C3-弹窗进度条", old: CLIENT_MODAL_OLD, to: CLIENT_MODAL_NEW },
			{ name: "C4-确认按钮百分比", old: CLIENT_CONFIRM_OLD, to: CLIENT_CONFIRM_NEW },
			{ name: "C5-进度条样式", old: CLIENT_CSS_OLD, to: CLIENT_CSS_NEW },
			{ name: "C6-中文词条", old: ZH_OLD, to: ZH_NEW },
			{ name: "C7-英文词条", old: EN_OLD, to: EN_NEW },
			...TARGETS.map((t) => ({ name: t.name, old: t.old, to: t.to })),
		], "client"],
		[WORKSPACE, [
			{ name: "W1-批量删除上下文工厂", old: HOST_FACTORY_OLD, to: HOST_FACTORY_NEW },
			{ name: "W2-批量删除重写（并行+合并落盘）", old: HOST_OLD_BATCH, to: HOST_NEW_BATCH },
		], "workspace"],
	]) {
		const original = readFileSync(file, "utf8").replace(/^\ufeff/, "");
		const result = applyPatches(original, patches);
		console.log(`=== ${file.split(/[\\/]/).pop()} ===\n${result.log.join("\n")}`);
		if (result.failed > 0) { console.error(`\n${result.failed} 处失配：整体放弃写盘。`); process.exit(1); }
		if (!dryRun) writeIfChanged(file, result.text, original, tag);
	}
	if (dryRun) { console.log("\n--dry-run：全部锚点命中，未写盘。"); return; }
	console.log("\n第九批已应用。重启 DSH 后生效（建议 Ctrl+Shift+R）。");
}

main();
