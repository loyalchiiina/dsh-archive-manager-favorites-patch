  /**
   * 快速批量删除：与 deleteArchivedSessions 结果同构，但显著更快。
   *
   * 与逐条 deleteSessionCore 的差别：
   *   1. 转录目录、缓存、spill 的删除并发执行（并发度 concurrency，默认 8）；
   *   2. 归档集合与工作区账户的写盘合并到末尾各做一次
   *      （逐条版本每删除一条会话就写两次全量索引，44 条即 88 次写盘）；
   *   3. 删除投影缓存前不再等待 whenIdle() 队列排空。
   * 数据安全项全部保留：子会话级联删除、转录目录整体删除、事件通知。
   *
   * @param target - 与 deleteArchivedSessions 相同的批量目标。
   * @param options - { concurrency?: number } 并发度（1..32）。
   */
  async deleteArchivedSessionsFast(target, options = {}) {
    return this.enqueueOperation(async () => {
      const requestedSessionIds = this.archivedSessionIdsForTarget(target);
      const rawConcurrency = Number(options?.concurrency);
      const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0
        ? Math.min(32, Math.max(1, Math.floor(rawConcurrency)))
        : 8;
      const deletedSessionIds = [];
      const skippedSessionIds = [];
      const failures = [];

      // ---- 阶段 1：筛选存在的会话（只读） ----
      const plans = [];
      for (const sessionId of requestedSessionIds) {
        try {
          if (!await this.sessionKnown(sessionId)) {
            skippedSessionIds.push(sessionId);
            continue;
          }
          plans.push(sessionId);
        } catch (error) {
          failures.push({ sessionId, message: String(error) });
        }
      }

      // ---- 阶段 2：并发删除文件层（转录目录 + 缓存 + spill + 子会话） ----
      const projCache = this.ctx.get("sessionProjectionCache");
      const sessions = this.ctx.get("sessions");
      const logWarn = (message) => {
        try { this.ctx.logger.warn(message); } catch {}
      };
      const removeOne = async (sessionId) => {
        const live = sessions?.get(sessionId);
        if (live !== void 0) {
          try {
            await sessions.flush(live);
            sessions.detachEntered(sessions.liveEntryFor(live));
          } catch (error) {
            logWarn("archive-manager(fast): detach failed for " + sessionId + ": " + String(error));
          }
        } else if (sessions !== void 0) {
          try { await this.publishColdSessionRemoval(sessionId, sessions); } catch {}
        }
        // 不再等 whenIdle()：直接把删除请求排入缓存自身的队列
        if (projCache !== void 0) {
          try { await projCache.delete(sessionId); } catch {}
        }
        try { await this.deleteDescendants(sessionId); } catch {}
        try { await this.cleanSpill(sessionId); } catch {}
        await this.removeTranscriptDirectory(sessionId);
      };

      for (let i = 0; i < plans.length; i += concurrency) {
        const slice = plans.slice(i, i + concurrency);
        const settled = await Promise.allSettled(slice.map((id) => removeOne(id)));
        for (let k = 0; k < settled.length; k += 1) {
          const sessionId = slice[k];
          const result = settled[k];
          if (result.status === "fulfilled") deletedSessionIds.push(sessionId);
          else failures.push({ sessionId, message: String(result.reason) });
        }
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
        // ---- 阶段 4：内存墓碑 + 通知 ----
        for (const sessionId of deletedSessionIds) {
          try {
            const deletedHeader = this.headers.get(sessionId) ?? sessions?.get(sessionId)?.header;
            this.forgetIndexedSession(sessionId);
            if (deletedHeader !== void 0) this.deletedIdentities.set(sessionId, headerIdentity(deletedHeader));
            this.publishDeletedSession(sessionId);
          } catch (error) {
            logWarn("archive-manager(fast): finalize failed for " + sessionId + ": " + String(error));
          }
        }
      }

      try {
        this.ctx.logger.info(
          "archive-manager(fast): deleted " + deletedSessionIds.length +
          ", skipped " + skippedSessionIds.length +
          ", failed " + failures.length +
          ", concurrency " + concurrency
        );
      } catch {}
      return { requestedSessionIds, deletedSessionIds, skippedSessionIds, failures };
    });
  }
