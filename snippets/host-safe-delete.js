  /**
   * 安全的批量删除（分步 + 超时 + 每步日志）。
   *
   * 设计目标：任何一步卡住都只等 timeoutMs，绝不永久阻塞主进程。
   * 每完成一步写一行日志到 ~/.dsh/archive-manager-delete.log，便于事后定位。
   *
   * @param target - 与 deleteArchivedSessions 相同的批量目标。
   * @param options - { concurrency?, stepTimeoutMs?, logPath? }
   */
  async deleteArchivedSessionsSafe(target, options = {}) {
    const rawConcurrency = Number(options?.concurrency);
    const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0
      ? Math.min(32, Math.max(1, Math.floor(rawConcurrency)))
      : 8;
    const rawTimeout = Number(options?.stepTimeoutMs);
    const stepTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(120000, Math.max(500, Math.floor(rawTimeout)))
      : 5000;

    // ---- 日志：同步写文件（卡死也不丢），同时发事件 ----
    const logLines = [];
    const logPath = (typeof options?.logPath === "string" && options.logPath.length > 0)
      ? options.logPath
      : (join(homedir(), ".dsh", "archive-manager-delete.log"));
    const say = (message) => {
      const line = new Date().toISOString().slice(11, 23) + " " + message;
      logLines.push(line);
      // 同步落盘：即使后续卡死，这一行也已经写到磁盘
      try { appendFileSync(logPath, line + "\n", "utf8"); } catch {}
      try { this.ctx.logger.info("archive-manager(safe): " + message); } catch {}
      try { this.ctx.emit("archive-manager/delete-step", { at: Date.now(), message }); } catch {}
    };
    try { appendFileSync(logPath, "\n===== delete request " + new Date().toISOString() + " =====\n", "utf8"); } catch {}
    say("logfile=" + logPath);

    // 超时包装：超时后不中断底层操作，但让上层继续往下走
    const withTimeout = async (label, promise, ms) => {
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          say(label + " TIMEOUT after " + ms + "ms (continuing)");
          resolve({ timedOut: true });
        }, ms);
      });
      try {
        const result = await Promise.race([promise.then((v) => ({ value: v })), timeout]);
        if (timer !== null) clearTimeout(timer);
        return result;
      } catch (error) {
        if (timer !== null) clearTimeout(timer);
        return { error: String(error) };
      }
    };

    const requestedSessionIds = this.archivedSessionIdsForTarget(target);
    say("start: requested=" + requestedSessionIds.length + " concurrency=" + concurrency + " stepTimeout=" + stepTimeoutMs + "ms");

    const deletedSessionIds = [];
    const skippedSessionIds = [];
    const failures = [];

    // ---- 步骤 1：解析目录（纯计算 + 读 header） ----
    const plans = [];
    for (let i = 0; i < requestedSessionIds.length; i += 1) {
      const sessionId = requestedSessionIds[i];
      const res = await withTimeout("resolve:" + sessionId, (async () => {
        const header = await this.readSessionHeader(sessionId);
        if (header === void 0 || header === null) return null;
        const persistence = this.ctx.get("sessionPersistence");
        let directory = null;
        if (persistence !== void 0 && typeof persistence.locate === "function") {
          const location = persistence.locate(header);
          if (location !== void 0 && typeof location.path === "string") {
            const resolved = jsonlSessionDirectory(persistence, header, location);
            directory = resolved !== void 0 ? resolved : dirname(location.path);
          }
        }
        return { sessionId, directory };
      })(), stepTimeoutMs);
      if (res.timedOut) { skippedSessionIds.push(sessionId); continue; }
      if (res.error) { failures.push({ sessionId, message: "resolve: " + res.error }); continue; }
      if (res.value === null) { skippedSessionIds.push(sessionId); continue; }
      plans.push(res.value);
      if ((i + 1) % 10 === 0) say("resolved " + (i + 1) + "/" + requestedSessionIds.length);
    }
    say("resolve done: plans=" + plans.length + " skipped=" + skippedSessionIds.length + " failed=" + failures.length);

    // ---- 步骤 2：并发删目录（最快、最安全的一步） ----
    const removeOne = async (plan) => {
      if (typeof plan.directory !== "string" || plan.directory.length === 0) return;
      let stat;
      try {
        stat = await lstat(plan.directory);
      } catch (error) {
        if (error?.code === "ENOENT") return; // 已经不在了
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error("refusing to delete symlink: " + plan.directory);
      if (!stat.isDirectory()) throw new Error("not a session directory: " + plan.directory);
      await rm(plan.directory, { recursive: true, force: true });
    };
    let removedCount = 0;
    for (let i = 0; i < plans.length; i += concurrency) {
      const slice = plans.slice(i, i + concurrency);
      const settled = await Promise.allSettled(slice.map((p) => removeOne(p)));
      for (let k = 0; k < settled.length; k += 1) {
        const plan = slice[k];
        const r = settled[k];
        if (r.status === "fulfilled") { deletedSessionIds.push(plan.sessionId); removedCount += 1; }
        else failures.push({ sessionId: plan.sessionId, message: "remove: " + String(r.reason) });
      }
      say("removed " + removedCount + "/" + plans.length);
    }
    say("remove done: deleted=" + deletedSessionIds.length + " failed=" + failures.length);

    // ---- 步骤 3：索引更新（各带超时） ----
    const removed = new Set(deletedSessionIds);
    if (removed.size > 0) {
      const r1 = await withTimeout("setState:archived", (async () => {
        const state = this.requireState();
        const nextArchived = state.archivedSessionIds.filter((id) => !removed.has(id));
        if (nextArchived.length !== state.archivedSessionIds.length) {
          await this.setState({ ...state, archivedSessionIds: nextArchived });
        }
      })(), stepTimeoutMs);
      if (r1.timedOut || r1.error) failures.push({ sessionId: "*archived-set*", message: r1.error ?? "timeout" });
      say("archived-set updated: " + (r1.timedOut ? "TIMEOUT" : r1.error ?? "ok"));

      const r2 = await withTimeout("table:accounts", (async () => {
        const table = this.requireTable();
        for (const workspaceId of this.requireState().workspaceIds) {
          const record = table.get(workspaceId);
          if (record === void 0) continue;
          if (!record.sessionIds.some((id) => removed.has(id))) continue;
          const next = await table.update(workspaceId, (current) => ({
            ...current,
            sessionIds: current.sessionIds.filter((id) => !removed.has(id)),
            updatedAt: (new Date()).toISOString()
          }));
          const entity = this.entities.get(workspaceId);
          if (entity !== void 0) entity.record = next;
        }
      })(), stepTimeoutMs);
      if (r2.timedOut || r2.error) failures.push({ sessionId: "*workspace-accounts*", message: r2.error ?? "timeout" });
      say("workspace accounts updated: " + (r2.timedOut ? "TIMEOUT" : r2.error ?? "ok"));

      // ---- 步骤 4：清缓存（每个都带超时，绝不整体卡住） ----
      const projCache = this.ctx.get("sessionProjectionCache");
      if (projCache !== void 0 && typeof projCache.delete === "function") {
        let cacheOk = 0;
        let cacheTimeout = 0;
        for (const sessionId of deletedSessionIds) {
          const r = await withTimeout("cache:" + sessionId, projCache.delete(sessionId), Math.min(stepTimeoutMs, 2000));
          if (r.timedOut) cacheTimeout += 1;
          else if (!r.error) cacheOk += 1;
        }
        say("cache cleanup: ok=" + cacheOk + " timeout=" + cacheTimeout);
      } else {
        say("cache cleanup: skipped (no sessionProjectionCache)");
      }

      // ---- 步骤 5：墓碑 + 通知 ----
      for (const sessionId of deletedSessionIds) {
        try {
          const deletedHeader = this.headers.get(sessionId) ?? this.ctx.get("sessions")?.get(sessionId)?.header;
          this.forgetIndexedSession(sessionId);
          if (deletedHeader !== void 0) this.deletedIdentities.set(sessionId, headerIdentity(deletedHeader));
          this.publishDeletedSession(sessionId);
        } catch (error) {
          say("finalize failed for " + sessionId + ": " + String(error));
        }
      }
      say("finalize done");
    }

    say("DONE deleted=" + deletedSessionIds.length + " skipped=" + skippedSessionIds.length + " failed=" + failures.length);
    return { requestedSessionIds, deletedSessionIds, skippedSessionIds, failures, log: logLines };
  }
