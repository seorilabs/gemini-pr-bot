import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import type { Config } from "./config.js";
import { withMysqlStatusReconciliationLock } from "./status-reconciliation.js";
import { MysqlWorkflowStore } from "./workflow.js";
import { STATUS_RECONCILIATION_EVENT } from "./events.js";

const port = Number(process.env.SEORI_STATUS_TEST_MYSQL_PORT ?? 0);
const enabled = Number.isInteger(port) && port > 0;

test(
  "실제 MySQL의 다른 connection끼리 PR lock을 공유하고 오류 뒤에도 해제한다",
  { skip: !enabled, timeout: 30_000 },
  async () => {
    const pool = mysql.createPool({
      host: "127.0.0.1",
      port,
      user: "root",
      database: "seori_status_reconciliation_test",
      connectionLimit: 4,
    });
    const key = `test:${randomUUID()}`;
    const lockName = `seori-status:${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const first = withMysqlStatusReconciliationLock(pool, key, async () => {
      order.push("first");
      enteredFirst();
      await hold;
    });
    let second: Promise<void> | undefined;
    try {
      await entered;
      const observer = await pool.getConnection();
      try {
        const [rows] = await observer.execute<RowDataPacket[]>(
          "SELECT GET_LOCK(?, 0) AS acquired",
          [lockName],
        );
        assert.equal(
          rows[0].acquired,
          0,
          "다른 connection은 보유 중인 실제 lock을 획득할 수 없어야 한다",
        );
      } finally {
        observer.release();
      }
      second = withMysqlStatusReconciliationLock(pool, key, async () => {
        order.push("second");
      });
      await withMysqlStatusReconciliationLock(
        pool,
        `${key}:other-pr`,
        async () => {
          order.push("other");
        },
      );
      assert.deepEqual(order, ["first", "other"]);
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepEqual(order, ["first", "other", "second"]);
      await assert.rejects(
        withMysqlStatusReconciliationLock(pool, key, async () => {
          throw new Error("expected test failure");
        }),
      );
      const [free] = await pool.execute<RowDataPacket[]>(
        "SELECT IS_FREE_LOCK(?) AS free",
        [lockName],
      );
      assert.equal(free[0].free, 1);
    } finally {
      releaseFirst();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      await pool.end();
    }
  },
);

test(
  "실제 MySQL에 중복 webhook을 동시에 등록해도 occurrence는 한 건이다",
  { skip: !enabled, timeout: 30_000 },
  async () => {
    const store = new MysqlWorkflowStore(
      {
        mysqlHost: "127.0.0.1",
        mysqlPort: port,
        mysqlUser: "root",
        mysqlDatabase: "seori_status_reconciliation_test",
        workflowMaxAttempts: 3,
        workflowLeaseMs: 30_000,
      } as Config,
      { info: () => {}, warn: () => {}, error: () => {} },
    );
    try {
      await store.init();
      const key = `delivery:${randomUUID()}`;
      const payload = {
        action: "resolved",
        repository: { full_name: "seorilabs/test-only" },
        pull_request: { number: 155 },
      };
      const outcomes = await Promise.all([
        store.enqueue(STATUS_RECONCILIATION_EVENT, key, payload),
        store.enqueue(STATUS_RECONCILIATION_EVENT, key, payload),
      ]);
      assert.deepEqual(outcomes.sort(), [false, true]);
      await store.enqueue("issue_comment", `${key}:standard`, payload);
      const status = await store.leaseNext("status-test-worker", "status");
      assert.equal(status?.eventName, STATUS_RECONCILIATION_EVENT);
      const standard = await store.leaseNext(
        "standard-test-worker",
        "standard",
      );
      assert.equal(standard?.eventName, "issue_comment");
      await store.complete(status!.id);
      await store.complete(standard!.id);
      assert.equal(await store.leaseNext("status-test-worker", "status"), null);
    } finally {
      await store.end();
    }
  },
);
