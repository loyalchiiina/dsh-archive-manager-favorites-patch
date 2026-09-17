  /**
   * 极速批量删除（插件自实现，不走逐条 deleteSessionCore）。
   *
   * 与 deleteSessionCore 的差别：
   *   - 不调用 sessionKnown/readSessionHeader 之外的内核流程；
   *   - 不做 flush / publishColdSessionRemoval / whenIdle 等待；
   *   - 目录解析用 persistence.locate + jsonlSessionDirectory（与内核同一套规则）；
   *   - 用 node:fs/promises 的 rm 直接删会话目录，并发执行；
   *   - 归档集合与工作区账户各只写一次盘；
   *   - 仍保留安全检查：拒绝符号链接、只删校验过的会话目录。
   *
   * @param target - 与 deleteArchivedSessions 相同的批量目标。
   * @param options - { concurrency?: number } 并发度（1..32，默认 12）。
   */
  async deleteArchivedSessionsDirect(target, options = {}) {
    const rawConcurrency = Number(options?.concurrency);
    const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0
      ? Math.min(32, Math.max(1, Math.floor(rawConcurrency)))
      : 12;
    const persistence = this.ctx.get("sessionPersistence");
    const requestedSessionIds = this.archivedSessionIdsForTarget(target);
    const deletedSessionIds = [];
    const skippedSessionIds = [];
    const failures = [];
    const removedDirs = [];

    // ---- 阶段 1：解析每个会话的目录（只读） ----
    const plans = [];
    for (const sessionId of requestedSessionIds) {
      let header;
      try {
        header = await this.readSessionHeader(sessionId);
      } catch (error) {
        skippedSessionIds.push(sessionId);
        continue;
      }
      if (header === void 0 || header === null) {
        skippedSessionIds.push(sessionId);
        continue;
      }
      let directory;
      try {
        if (persistence !== void 0 && typeof persistence.locate === "function") {
          const location = persistence.locate(header);
          if (location !== void 0 && typeof location.path === "string") {
            const resolved = jsonlSessionDirectory(persistence, header, location);
            directory = resolved !== void 0 ? resolved : dirname(location.path);
          }
        }
      } catch (error) {
        failures.push({ sessionId, message: "locate: " + String(error) });
        continue;
      }
      plans.push({ sessionId, directory });
    }

    // ---- 阶段 2：并发删除目录 ----
    const removeOne = async (plan) => {
      if (typeof plan.directory !== "string" || plan.directory.length === 0) return;
      let stat;
      try {
        stat = await lstat(plan.directory);
      } catch (error) {
        if (error?.code === "ENOENT") return; // 已经不在了，视为已删
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error("refusing to delete through symbolic link: " + plan.directory);
      if (!stat.isDirectory()) throw new Error("expected a session directory: " + plan.directory);
      await rm(plan.directory, { recursive: true, force: true });
    };

    for (let i = 0; i < plans.length; i += concurrency) {
      const slice = plans.slice(i, i + concurrency);
      const settled = await Promise.allSettled(slice.map((plan) => removeOne(plan)));
      for (let k = 0; k < settled.length; k += 1) {
        const plan = slice[k];
        const result = settled[k];
        if (result.status === "fulfilled") {
          deletedSessionIds.push(plan.sessionId);
          if (typeof plan.directory === "string") removedDirs.push(plan.directory);
        } else {
          failures.push({ sessionId: plan.sessionId, message: String(result.reason) });
        }
      }
      try {
        this.ctx.logger.info("archive-manager(direct): removed " + deletedSessionIds.length + "/" + plans.length + " session dir(s)");
      } catch {}
    }

    // ---- 阶段 3：索引只写一次 ----
    const removed = new Set(deletedSessionIds);
    if (removed.size > 0) {
      try {
        const state = this.requireState();
        const nextArchived = state.archivedSessionIds.filter((id) => !removed.has(id));
        if (nextArchived.length !== state.archivedSessionIds.length) {
          await this.setState({ ...state, archivedSessionIds: nextArchived });
        }
      } catch (error) {
        failures.push({ sessionId: "*archived-set*", message: String(error) });
      }
      try {
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
      } catch (error) {
        failures.push({ sessionId: "*workspace-accounts*", message: String(error) });
      }
      // 清投影缓存（不等待队列）
      const projCache = this.ctx.get("sessionProjectionCache");
      if (projCache !== void 0) {
        for (const sessionId of deletedSessionIds) {
          try { await projCache.delete(sessionId); } catch {}
        }
      }
      // 墓碑 + 通知
      for (const sessionId of deletedSessionIds) {
        try {
          const deletedHeader = this.headers.get(sessionId) ?? this.ctx.get("sessions")?.get(sessionId)?.header;
          this.forgetIndexedSession(sessionId);
          if (deletedHeader !== void 0) this.deletedIdentities.set(sessionId, headerIdentity(deletedHeader));
          this.publishDeletedSession(sessionId);
        } catch (error) {
          try { this.ctx.logger.warn("archive-manager(direct): finalize failed for " + sessionId + ": " + String(error)); } catch {}
        }
      }
    }

    try {
      this.ctx.logger.info(
        "archive-manager(direct): done deleted=" + deletedSessionIds.length +
        " skipped=" + skippedSessionIds.length +
        " failed=" + failures.length +
        " concurrency=" + concurrency
      );
    } catch {}
    return { requestedSessionIds, deletedSessionIds, skippedSessionIds, failures, removedDirs };
  }
