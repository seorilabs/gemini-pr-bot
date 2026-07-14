import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import type { App } from "octokit";
import type { Config } from "./config.js";
import type { PrBot, WorkflowCheckRecord } from "./bot.js";
import { isAiProviderCooldownError } from "./gemini.js";
import { completeCheck, type RepoRef } from "./github.js";
import type { StoredFinding } from "./review.js";
import type { ReviewRunRecord } from "./review-run.js";
import {
  parseStoredReviewFinding,
  type StoredReviewFinding,
} from "./review-finding-ledger.js";
import { metrics, type ActiveWorkflowMetric, type WorkflowQueueMetric } from "./metrics.js";

type Logger = {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
  error: (value: unknown, message?: string) => void;
};

type WebhookEvent = {
  id?: string;
  name?: string;
  payload: any;
};

type WorkflowRow = RowDataPacket & {
  id: number;
  dedupe_key: string;
  event_name: string;
  payload_json: string;
  attempts: number;
  max_attempts: number;
  check_run_id: number | null;
  created_at: Date | string;
};

type ExpiredWorkflowRow = WorkflowRow & {
  repo_full_name: string | null;
  pr_number: number | null;
  head_sha: string | null;
  check_kind: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
};

type ReviewFindingRow = RowDataPacket & {
  fingerprint: string;
  severity: string;
  category: string;
  file: string | null;
  title: string;
  status: string;
  review_comment_id: number | null;
  thread_node_id: string | null;
  issue_number: number | null;
  first_seen_head: string;
  last_seen_head: string;
};

type ReviewGateFindingRow = RowDataPacket & {
  finding_json: string;
  review_comment_id: number | string | null;
  thread_node_id: string | null;
};

type ReviewGateFindingHeadRow = RowDataPacket & {
  last_evaluated_head: string;
  context_hash: string;
  state: string;
};

type CachedReviewRunRow = RowDataPacket & {
  raw_output: string;
  verdict: string;
};

export type ReviewFindingUpsert = {
  fingerprint: string;
  severity: string;
  category: string;
  file: string | null;
  title: string;
  headSha: string;
  reviewCommentId?: number | null;
  threadNodeId?: string | null;
  issueNumber?: number | null;
};

export type ReviewFindingStore = {
  listOpenReviewFindings: (repoFullName: string, prNumber: number) => Promise<StoredFinding[]>;
  upsertReviewFinding: (repoFullName: string, prNumber: number, finding: ReviewFindingUpsert) => Promise<void>;
  markReviewFindingResolved: (repoFullName: string, prNumber: number, fingerprint: string) => Promise<void>;
};

export type ReviewGateFindingRecord = {
  finding: StoredReviewFinding;
  reviewCommentId: number | null;
  threadNodeId: string | null;
  /** Snapshot loaded before this write. Used to reject stale cross-HEAD updates. */
  expectedLastEvaluatedHeadSha?: string | null;
  expectedContextHash?: string | null;
};

export type ReviewGateFindingStore = {
  listReviewGateFindings: (repoFullName: string, prNumber: number) => Promise<ReviewGateFindingRecord[]>;
  upsertReviewGateFinding: (
    repoFullName: string,
    prNumber: number,
    record: ReviewGateFindingRecord,
  ) => Promise<boolean>;
};

export type CachedReviewRun = {
  rawOutput: string;
  verdict: ReviewRunRecord["verdict"];
};

export type ExpiredWorkflowRun = WorkflowRun & {
  repoFullName: string | null;
  prNumber: number | null;
  headSha: string | null;
  checkKind: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | string | null;
};

type WorkflowQueueMetricRow = RowDataPacket & {
  status: string;
  event_name: string;
  row_count: number | string;
  ready_count: number | string;
  oldest_age_seconds: number | string | null;
};

type ActiveWorkflowMetricRow = RowDataPacket & {
  id: number | string;
  status: string;
  event_name: string;
  payload_json: string;
  attempts: number | string;
  check_kind: string | null;
  repo_full_name: string | null;
  pr_number: number | string | null;
  head_sha: string | null;
  age_seconds: number | string | null;
  next_run_delay_seconds: number | string | null;
};

type ActiveReviewWorkflowRow = RowDataPacket & {
  id: number | string;
  status: string;
  event_name: string;
  payload_json: string;
  check_run_id: number | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
};

export type WorkflowRun = {
  id: number;
  dedupeKey: string;
  eventName: string;
  payload: any;
  attempts: number;
  maxAttempts: number;
  checkRunId: number | null;
  createdAt: Date | string;
};

export type WorkflowTargetRecord = Omit<WorkflowCheckRecord, "checkRunId">;

export type ActiveReviewWorkflow = {
  workflowId: number;
  status: string;
  eventName: string;
  payload: any;
  checkRunId: number | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
};

export class MysqlWorkflowStore {
  private readonly pool: Pool;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.pool = mysql.createPool({
      host: config.mysqlHost,
      port: config.mysqlPort,
      user: config.mysqlUser,
      password: config.mysqlPassword,
      database: config.mysqlDatabase,
      waitForConnections: true,
      connectionLimit: 5,
      namedPlaceholders: false,
    });
  }

  async init(): Promise<void> {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS gemini_pr_bot_workflows (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        dedupe_key VARCHAR(255) NOT NULL,
        event_name VARCHAR(80) NOT NULL,
        payload_json LONGTEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'queued',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        lease_owner VARCHAR(160) NULL,
        lease_expires_at DATETIME(3) NULL,
        next_run_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        check_run_id BIGINT UNSIGNED NULL,
        check_kind VARCHAR(32) NULL,
        repo_full_name VARCHAR(255) NULL,
        pr_number INT NULL,
        head_sha VARCHAR(64) NULL,
        last_error TEXT NULL,
        started_at DATETIME(3) NULL,
        completed_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_gemini_pr_bot_workflows_dedupe (dedupe_key),
        KEY idx_gemini_pr_bot_workflows_ready (status, next_run_at),
        KEY idx_gemini_pr_bot_workflows_lease (status, lease_expires_at),
        KEY idx_gemini_pr_bot_workflows_pr (repo_full_name, pr_number, head_sha)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS gemini_pr_bot_review_findings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        repo_full_name VARCHAR(255) NOT NULL,
        pr_number INT NOT NULL,
        fingerprint CHAR(40) NOT NULL,
        severity VARCHAR(16) NOT NULL,
        category VARCHAR(40) NOT NULL,
        file VARCHAR(512) NULL,
        title TEXT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'open',
        review_comment_id BIGINT UNSIGNED NULL,
        thread_node_id VARCHAR(120) NULL,
        issue_number INT NULL,
        first_seen_head VARCHAR(64) NOT NULL,
        last_seen_head VARCHAR(64) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_review_finding (repo_full_name, pr_number, fingerprint),
        KEY idx_review_finding_pr (repo_full_name, pr_number, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS gemini_pr_bot_review_runs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        workflow_id BIGINT UNSIGNED NOT NULL,
        check_run_id BIGINT UNSIGNED NULL,
        repo_full_name VARCHAR(255) NOT NULL,
        pr_number INT NOT NULL,
        head_sha VARCHAR(64) NOT NULL,
        provider VARCHAR(32) NOT NULL,
        model VARCHAR(160) NOT NULL,
        prompt_version VARCHAR(80) NOT NULL,
        prompt_sha256 CHAR(64) NOT NULL,
        context_sha256 CHAR(64) NOT NULL,
        raw_output LONGTEXT NOT NULL,
        parse_valid BOOLEAN NOT NULL,
        verdict VARCHAR(16) NOT NULL,
        validation_errors_json LONGTEXT NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_review_runs_pr (repo_full_name, pr_number, head_sha),
        KEY idx_review_runs_workflow (workflow_id),
        KEY idx_review_runs_provider (provider, model, created_at),
        KEY idx_review_runs_verdict (verdict, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS gemini_pr_bot_review_gate_findings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        repo_full_name VARCHAR(255) NOT NULL,
        pr_number INT NOT NULL,
        semantic_fingerprint CHAR(64) NOT NULL,
        state VARCHAR(16) NOT NULL,
        first_seen_head VARCHAR(64) NOT NULL,
        last_seen_head VARCHAR(64) NOT NULL,
        last_evaluated_head VARCHAR(64) NOT NULL,
        context_hash CHAR(64) NOT NULL,
        finding_json LONGTEXT NOT NULL,
        review_comment_id BIGINT UNSIGNED NULL,
        thread_node_id VARCHAR(120) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_review_gate_finding (repo_full_name, pr_number, semantic_fingerprint),
        KEY idx_review_gate_finding_pr (repo_full_name, pr_number, state)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  async listReviewGateFindings(
    repoFullName: string,
    prNumber: number,
  ): Promise<ReviewGateFindingRecord[]> {
    const [rows] = await this.pool.execute<ReviewGateFindingRow[]>(
      `
      SELECT finding_json, review_comment_id, thread_node_id
      FROM gemini_pr_bot_review_gate_findings
      WHERE repo_full_name = ? AND pr_number = ?
      ORDER BY id ASC
      `,
      [repoFullName, prNumber],
    );
    const records: ReviewGateFindingRecord[] = [];
    for (const row of rows) {
      try {
        records.push({
          finding: parseStoredReviewFinding(JSON.parse(row.finding_json)),
          reviewCommentId: row.review_comment_id == null ? null : Number(row.review_comment_id),
          threadNodeId: row.thread_node_id,
        });
      } catch (error) {
        this.logger.warn({ error, repoFullName, prNumber }, "invalid stored review gate finding ignored");
      }
    }
    return records;
  }

  async upsertReviewGateFinding(
    repoFullName: string,
    prNumber: number,
    record: ReviewGateFindingRecord,
  ): Promise<boolean> {
    const finding = record.finding;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<ReviewGateFindingHeadRow[]>(
        `
        SELECT last_evaluated_head, context_hash, state
        FROM gemini_pr_bot_review_gate_findings
        WHERE repo_full_name = ? AND pr_number = ? AND semantic_fingerprint = ?
        FOR UPDATE
        `,
        [repoFullName, prNumber, finding.semanticFingerprint],
      );
      const existingHead = rows[0]?.last_evaluated_head ?? null;
      const existingContext = rows[0]?.context_hash ?? null;
      const existingState = rows[0]?.state ?? null;
      const expectedHead = record.expectedLastEvaluatedHeadSha ?? null;
      const expectedContext = record.expectedContextHash ?? null;
      const expectedSnapshotMatches =
        existingHead === expectedHead && existingContext === expectedContext;
      const idAttachmentForSameSnapshot =
        existingHead === finding.lastEvaluatedHeadSha &&
        existingContext === finding.contextHash &&
        existingState === finding.state;
      if (
        existingHead !== null &&
        !expectedSnapshotMatches &&
        !idAttachmentForSameSnapshot
      ) {
        await connection.rollback();
        this.logger.warn(
          {
            repoFullName,
            prNumber,
            fingerprint: finding.semanticFingerprint,
            existingHead,
            existingContext,
            existingState,
            expectedHead,
            expectedContext,
            attemptedHead: finding.lastEvaluatedHeadSha,
            attemptedContext: finding.contextHash,
            attemptedState: finding.state,
          },
          "stale review gate finding write ignored",
        );
        return false;
      }

      await connection.execute(
        `
        INSERT INTO gemini_pr_bot_review_gate_findings
          (repo_full_name, pr_number, semantic_fingerprint, state,
           first_seen_head, last_seen_head, last_evaluated_head, context_hash,
           finding_json, review_comment_id, thread_node_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          state = VALUES(state),
          last_seen_head = VALUES(last_seen_head),
          last_evaluated_head = VALUES(last_evaluated_head),
          context_hash = VALUES(context_hash),
          finding_json = VALUES(finding_json),
          review_comment_id = COALESCE(VALUES(review_comment_id), review_comment_id),
          thread_node_id = COALESCE(VALUES(thread_node_id), thread_node_id)
        `,
        [
          repoFullName,
          prNumber,
          finding.semanticFingerprint,
          finding.state,
          finding.firstSeenHeadSha,
          finding.lastSeenHeadSha,
          finding.lastEvaluatedHeadSha,
          finding.contextHash,
          JSON.stringify(finding),
          record.reviewCommentId,
          record.threadNodeId,
        ],
      );
      await connection.commit();
      return true;
    } catch (error) {
      await rollbackQuietly(connection, this.logger);
      throw error;
    } finally {
      connection.release();
    }
  }

  async findCachedReviewGateRun(
    repoFullName: string,
    prNumber: number,
    headSha: string,
    promptVersion: string,
    contextSha256: string,
  ): Promise<CachedReviewRun | null> {
    const [rows] = await this.pool.execute<CachedReviewRunRow[]>(
      `
      SELECT runs.raw_output, runs.verdict
      FROM gemini_pr_bot_review_runs AS runs
      INNER JOIN gemini_pr_bot_workflows AS workflows
        ON workflows.id = runs.workflow_id
      WHERE runs.repo_full_name = ? AND runs.pr_number = ? AND runs.head_sha = ?
        AND runs.provider = 'host' AND runs.prompt_version = ? AND runs.context_sha256 = ?
        AND runs.parse_valid = TRUE AND runs.verdict IN ('PASS', 'FAIL')
        AND workflows.status = 'completed'
      ORDER BY runs.id DESC
      LIMIT 1
      `,
      [repoFullName, prNumber, headSha, promptVersion, contextSha256],
    );
    const row = rows[0];
    if (!row || !["PASS", "FAIL", "ABSTAIN"].includes(row.verdict)) {
      return null;
    }
    return {
      rawOutput: row.raw_output,
      verdict: row.verdict as ReviewRunRecord["verdict"],
    };
  }

  async listOpenReviewFindings(repoFullName: string, prNumber: number): Promise<StoredFinding[]> {
    const [rows] = await this.pool.execute<ReviewFindingRow[]>(
      `
      SELECT fingerprint, severity, category, file, title, status,
             review_comment_id, thread_node_id, issue_number, first_seen_head, last_seen_head
      FROM gemini_pr_bot_review_findings
      WHERE repo_full_name = ? AND pr_number = ? AND status = 'open'
      `,
      [repoFullName, prNumber],
    );
    return rows.map((row) => ({
      fingerprint: row.fingerprint,
      severity: row.severity,
      category: row.category,
      file: row.file,
      title: row.title,
      status: row.status === "resolved" ? "resolved" : "open",
      reviewCommentId: row.review_comment_id === null ? null : Number(row.review_comment_id),
      threadNodeId: row.thread_node_id,
      issueNumber: row.issue_number === null ? null : Number(row.issue_number),
      firstSeenHead: row.first_seen_head,
      lastSeenHead: row.last_seen_head,
    }));
  }

  async upsertReviewFinding(repoFullName: string, prNumber: number, finding: ReviewFindingUpsert): Promise<void> {
    await this.pool.execute(
      `
      INSERT INTO gemini_pr_bot_review_findings
        (repo_full_name, pr_number, fingerprint, severity, category, file, title, status,
         review_comment_id, thread_node_id, issue_number, first_seen_head, last_seen_head)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        severity = VALUES(severity),
        category = VALUES(category),
        file = VALUES(file),
        title = VALUES(title),
        status = 'open',
        review_comment_id = COALESCE(VALUES(review_comment_id), review_comment_id),
        thread_node_id = COALESCE(VALUES(thread_node_id), thread_node_id),
        issue_number = COALESCE(VALUES(issue_number), issue_number),
        last_seen_head = VALUES(last_seen_head)
      `,
      [
        repoFullName,
        prNumber,
        finding.fingerprint,
        finding.severity,
        finding.category,
        finding.file,
        finding.title,
        finding.reviewCommentId ?? null,
        finding.threadNodeId ?? null,
        finding.issueNumber ?? null,
        finding.headSha,
        finding.headSha,
      ],
    );
  }

  async markReviewFindingResolved(repoFullName: string, prNumber: number, fingerprint: string): Promise<void> {
    await this.pool.execute(
      `
      UPDATE gemini_pr_bot_review_findings
      SET status = 'resolved'
      WHERE repo_full_name = ? AND pr_number = ? AND fingerprint = ?
      `,
      [repoFullName, prNumber, fingerprint],
    );
  }

  async recordReviewRun(workflowId: number, record: ReviewRunRecord): Promise<void> {
    await this.pool.execute(
      `
      INSERT INTO gemini_pr_bot_review_runs
        (workflow_id, check_run_id, repo_full_name, pr_number, head_sha,
         provider, model, prompt_version, prompt_sha256, context_sha256,
         raw_output, parse_valid, verdict, validation_errors_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        workflowId,
        record.checkRunId,
        record.repoFullName,
        record.prNumber,
        record.headSha,
        record.provider,
        record.model,
        record.promptVersion,
        record.promptSha256,
        record.contextSha256,
        record.rawOutput,
        record.parseValid,
        record.verdict,
        JSON.stringify(record.validationErrors),
      ],
    );
  }

  async enqueue(eventName: string, dedupeKey: string, payload: any, delayMs = 0): Promise<boolean> {
    const payloadJson = JSON.stringify(payload);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `
      INSERT IGNORE INTO gemini_pr_bot_workflows
        (dedupe_key, event_name, payload_json, status, max_attempts, next_run_at)
      VALUES (?, ?, ?, 'queued', ?, TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3)))
      `,
      [dedupeKey, eventName, payloadJson, this.config.workflowMaxAttempts, delayMs * 1000],
    );
    return result.affectedRows > 0;
  }

  async leaseNext(workerId: string): Promise<WorkflowRun | null> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<WorkflowRow[]>(
        `
        SELECT
          id,
          dedupe_key,
          event_name,
          payload_json,
          attempts,
          max_attempts,
          check_run_id,
          created_at
        FROM gemini_pr_bot_workflows
        WHERE
          attempts < max_attempts
          AND (
            (status = 'queued' AND next_run_at <= CURRENT_TIMESTAMP(3))
            OR (status = 'running' AND lease_expires_at < CURRENT_TIMESTAMP(3))
          )
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
        `,
      );

      const row = rows[0];
      if (!row) {
        await connection.commit();
        return null;
      }

      await connection.execute(
        `
        UPDATE gemini_pr_bot_workflows
        SET
          status = 'running',
          attempts = attempts + 1,
          lease_owner = ?,
          lease_expires_at = TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3)),
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
          last_error = NULL
        WHERE id = ?
        `,
        [workerId, this.config.workflowLeaseMs * 1000, row.id],
      );

      await connection.commit();

      return {
        id: row.id,
        dedupeKey: row.dedupe_key,
        eventName: row.event_name,
        payload: JSON.parse(row.payload_json),
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts,
        checkRunId: row.check_run_id,
        createdAt: row.created_at,
      };
    } catch (error) {
      await rollbackQuietly(connection, this.logger);
      throw error;
    } finally {
      connection.release();
    }
  }

  async leaseExpiredFinalAttempt(workerId: string): Promise<ExpiredWorkflowRun | null> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<ExpiredWorkflowRow[]>(
        `
        SELECT
          id,
          dedupe_key,
          event_name,
          payload_json,
          attempts,
          max_attempts,
          check_run_id,
          repo_full_name,
          pr_number,
          head_sha,
          check_kind,
          lease_owner,
          lease_expires_at,
          created_at
        FROM gemini_pr_bot_workflows
        WHERE
          status = 'running'
          AND attempts >= max_attempts
          AND lease_expires_at < CURRENT_TIMESTAMP(3)
        ORDER BY lease_expires_at ASC, updated_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
        `,
      );

      const row = rows[0];
      if (!row) {
        await connection.commit();
        return null;
      }

      await connection.execute(
        `
        UPDATE gemini_pr_bot_workflows
        SET
          lease_owner = ?,
          lease_expires_at = TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3))
        WHERE id = ?
        `,
        [workerId, this.config.workflowLeaseMs * 1000, row.id],
      );

      await connection.commit();

      return {
        id: Number(row.id),
        dedupeKey: row.dedupe_key,
        eventName: row.event_name,
        payload: JSON.parse(row.payload_json),
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        checkRunId: row.check_run_id === null ? null : Number(row.check_run_id),
        createdAt: row.created_at,
        repoFullName: row.repo_full_name,
        prNumber: row.pr_number === null ? null : Number(row.pr_number),
        headSha: row.head_sha,
        checkKind: row.check_kind,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at,
      };
    } catch (error) {
      await rollbackQuietly(connection, this.logger);
      throw error;
    } finally {
      connection.release();
    }
  }

  async recordCheckRun(id: number, record: WorkflowCheckRecord): Promise<void> {
    await this.pool.execute(
      `
      UPDATE gemini_pr_bot_workflows
      SET
        check_run_id = ?,
        check_kind = ?,
        repo_full_name = ?,
        pr_number = ?,
        head_sha = ?
      WHERE id = ?
      `,
      [record.checkRunId, record.kind, record.repoFullName, record.prNumber, record.headSha, id],
    );
  }

  async recordWorkflowTarget(id: number, record: WorkflowTargetRecord): Promise<void> {
    await this.pool.execute(
      `
      UPDATE gemini_pr_bot_workflows
      SET
        check_kind = ?,
        repo_full_name = ?,
        pr_number = ?,
        head_sha = ?
      WHERE id = ?
      `,
      [record.kind, record.repoFullName, record.prNumber, record.headSha, id],
    );
  }

  async findActiveReviewWorkflow(
    currentWorkflowId: number,
    currentCreatedAt: Date | string,
    record: WorkflowTargetRecord,
  ): Promise<ActiveReviewWorkflow | null> {
    const [rows] = await this.pool.execute<ActiveReviewWorkflowRow[]>(
      `
      SELECT
        id,
        status,
        event_name,
        payload_json,
        check_run_id,
        started_at,
        completed_at
      FROM gemini_pr_bot_workflows
      WHERE
        id < ?
        AND check_kind = ?
        AND repo_full_name = ?
        AND pr_number = ?
        AND head_sha = ?
        AND (
          status = 'queued'
          OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at >= CURRENT_TIMESTAMP(3)))
          OR (
            status = 'completed'
            AND started_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND started_at <= ?
            AND completed_at >= ?
          )
        )
      ORDER BY FIELD(status, 'running', 'queued', 'completed'), id ASC
      LIMIT 1
      `,
      [
        currentWorkflowId,
        record.kind,
        record.repoFullName,
        record.prNumber,
        record.headSha,
        currentCreatedAt,
        currentCreatedAt,
      ],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      workflowId: Number(row.id),
      status: row.status,
      eventName: row.event_name,
      payload: JSON.parse(row.payload_json),
      checkRunId: row.check_run_id === null ? null : Number(row.check_run_id),
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  async complete(id: number): Promise<void> {
    await this.pool.execute(
      `
      UPDATE gemini_pr_bot_workflows
      SET
        status = 'completed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        completed_at = CURRENT_TIMESTAMP(3),
        last_error = NULL
      WHERE id = ?
      `,
      [id],
    );
  }

  async fail(run: WorkflowRun, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const willRetry = run.attempts < run.maxAttempts;
    const retryDelaySeconds = Math.min(300, 15 * 2 ** Math.max(0, run.attempts - 1));
    await this.pool.execute(
      `
      UPDATE gemini_pr_bot_workflows
      SET
        status = ?,
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_run_at = IF(? = 'queued', TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)), next_run_at),
        completed_at = IF(? = 'failed', CURRENT_TIMESTAMP(3), completed_at),
        last_error = ?
      WHERE id = ?
      `,
      [
        willRetry ? "queued" : "failed",
        willRetry ? "queued" : "failed",
        retryDelaySeconds,
        willRetry ? "queued" : "failed",
        truncateError(message),
        run.id,
      ],
    );
  }

  async deferForProviderCooldown(run: WorkflowRun, delayMs: number, message: string): Promise<void> {
    await this.pool.execute(
      `
      UPDATE gemini_pr_bot_workflows
      SET
        status = 'queued',
        attempts = GREATEST(attempts - 1, 0),
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_run_at = TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3)),
        last_error = ?
      WHERE id = ?
      `,
      [Math.ceil(delayMs) * 1000, truncateError(message), run.id],
    );
  }

  async failExpiredFinalAttempt(run: ExpiredWorkflowRun, message: string): Promise<void> {
    await this.pool.execute(
      `
      UPDATE gemini_pr_bot_workflows
      SET
        status = 'failed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        completed_at = CURRENT_TIMESTAMP(3),
        last_error = ?
      WHERE id = ?
      `,
      [truncateError(message), run.id],
    );
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  async queueMetrics(): Promise<WorkflowQueueMetric[]> {
    const [rows] = await this.pool.execute<WorkflowQueueMetricRow[]>(`
      SELECT
        status,
        event_name,
        COUNT(*) AS row_count,
        SUM(CASE WHEN status = 'queued' AND next_run_at <= CURRENT_TIMESTAMP(3) THEN 1 ELSE 0 END) AS ready_count,
        MAX(TIMESTAMPDIFF(MICROSECOND, created_at, CURRENT_TIMESTAMP(3))) / 1000000 AS oldest_age_seconds
      FROM gemini_pr_bot_workflows
      GROUP BY status, event_name
      ORDER BY status, event_name
    `);

    return rows.map((row) => ({
      status: row.status,
      eventName: row.event_name,
      count: Number(row.row_count || 0),
      readyCount: Number(row.ready_count || 0),
      oldestAgeSeconds: Number(row.oldest_age_seconds || 0),
    }));
  }

  async activeWorkflowMetrics(): Promise<ActiveWorkflowMetric[]> {
    const [rows] = await this.pool.execute<ActiveWorkflowMetricRow[]>(`
      SELECT
        id,
        status,
        event_name,
        payload_json,
        attempts,
        check_kind,
        repo_full_name,
        pr_number,
        head_sha,
        TIMESTAMPDIFF(MICROSECOND, created_at, CURRENT_TIMESTAMP(3)) / 1000000 AS age_seconds,
        GREATEST(TIMESTAMPDIFF(MICROSECOND, CURRENT_TIMESTAMP(3), next_run_at) / 1000000, 0) AS next_run_delay_seconds
      FROM gemini_pr_bot_workflows
      WHERE status IN ('queued', 'running')
      ORDER BY
        FIELD(status, 'running', 'queued'),
        next_run_at ASC,
        created_at ASC
      LIMIT 50
    `);

    return rows.map((row) => activeWorkflowMetricFromRow(row));
  }

}

export class WorkflowEngine {
  private readonly workerId = `${os.hostname()}-${process.pid}-${randomUUID()}`;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly app: App,
    private readonly bot: PrBot,
    private readonly store: MysqlWorkflowStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    await this.store.init();
    this.running = true;
    this.loopPromise = this.loop();
    this.logger.info(
      {
        workerId: this.workerId,
        pollIntervalMs: this.config.workflowPollIntervalMs,
        leaseMs: this.config.workflowLeaseMs,
      },
      "workflow worker started",
    );
  }

  async enqueue(eventName: string, event: WebhookEvent): Promise<void> {
    const dedupeKey = this.dedupeKey(eventName, event);
    const inserted = await this.store.enqueue(eventName, dedupeKey, event.payload);
    metrics.recordWorkflowEnqueued(eventName, "webhook", inserted);
    this.logger.info(
      {
        event: eventName,
        dedupeKey,
        inserted,
        repo: event.payload.repository?.full_name,
        action: event.payload.action,
      },
      "workflow enqueued",
    );
  }

  async enqueueSynthetic(eventName: string, dedupeKey: string, payload: any, delayMs = 0): Promise<boolean> {
    const inserted = await this.store.enqueue(eventName, dedupeKey, payload, delayMs);
    metrics.recordWorkflowEnqueued(eventName, "synthetic", inserted);
    this.logger.info(
      {
        event: eventName,
        dedupeKey,
        inserted,
        delayMs,
        repo: payload.repository?.full_name,
        action: payload.action,
      },
      "synthetic workflow enqueued",
    );
    return inserted;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    await this.store.end();
  }

  async queueMetrics(): Promise<WorkflowQueueMetric[]> {
    return this.store.queueMetrics();
  }

  async activeWorkflowMetrics(): Promise<ActiveWorkflowMetric[]> {
    return this.store.activeWorkflowMetrics();
  }

  async leaseExpiredFinalAttempt(): Promise<ExpiredWorkflowRun | null> {
    return this.store.leaseExpiredFinalAttempt(this.workerId);
  }

  async failExpiredFinalAttempt(run: ExpiredWorkflowRun, message: string): Promise<void> {
    await this.store.failExpiredFinalAttempt(run, message);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        let processed = false;
        do {
          processed = (await this.processExpiredFinalAttempt()) || (await this.processOne());
        } while (this.running && processed);
      } catch (error) {
        this.logger.error({ error }, "workflow worker loop failed");
      }

      if (this.running) {
        await delay(this.config.workflowPollIntervalMs);
      }
    }
  }

  private async processExpiredFinalAttempt(): Promise<boolean> {
    const run = await this.leaseExpiredFinalAttempt();
    if (!run) {
      return false;
    }

    const message = [
      `Workflow ${run.id} expired while marked running after ${run.attempts}/${run.maxAttempts} attempts.`,
      `Previous lease owner: ${run.leaseOwner || "unknown"}`,
      `Previous lease expired at: ${run.leaseExpiresAt || "unknown"}`,
    ].join("\n");

    this.logger.warn(
      {
        workflowId: run.id,
        event: run.eventName,
        attempt: run.attempts,
        maxAttempts: run.maxAttempts,
        checkRunId: run.checkRunId,
        repo: run.repoFullName,
        prNumber: run.prNumber,
      },
      "expired final-attempt workflow recovered as failed",
    );

    try {
      await this.completeExpiredCheckRun(run, message);
    } catch (error) {
      this.logger.warn(
        {
          error,
          workflowId: run.id,
          checkRunId: run.checkRunId,
          repo: run.repoFullName,
          prNumber: run.prNumber,
        },
        "expired workflow check-run completion failed",
      );
    }

    await this.failExpiredFinalAttempt(run, message);
    metrics.recordWorkflowFailed(run.eventName, true, 0);
    return true;
  }

  private async completeExpiredCheckRun(run: ExpiredWorkflowRun, message: string): Promise<void> {
    if (!run.checkRunId) {
      return;
    }

    const installationId = run.payload.installation?.id;
    if (!installationId) {
      throw new Error("Webhook payload does not include installation.id");
    }

    const repo = repoFromWorkflowRun(run);
    if (!repo) {
      throw new Error("Workflow payload does not include repository identity");
    }

    const octokit = await this.app.getInstallationOctokit(installationId);
    await completeCheck(
      octokit,
      repo,
      run.checkRunId,
      "failure",
      "Review workflow expired",
      [
        "Seori review workflow lease expired after the maximum attempt count.",
        "",
        message,
        "",
        "Request a new review after checking bot logs or provider health.",
      ].join("\n"),
    );
  }

  private async processOne(): Promise<boolean> {
    const run = await this.store.leaseNext(this.workerId);
    if (!run) {
      return false;
    }

    this.logger.info(
      {
        workflowId: run.id,
        event: run.eventName,
        attempt: run.attempts,
        maxAttempts: run.maxAttempts,
      },
      "workflow leased",
    );
    metrics.recordWorkflowLeased(run.eventName);

    const startedAt = Date.now();
    try {
      const installationId = run.payload.installation?.id;
      if (!installationId) {
        throw new Error("Webhook payload does not include installation.id");
      }

      const installationToken = await this.createInstallationToken(installationId);
      const octokit = await this.app.getInstallationOctokit(installationId);
      await this.bot.processEvent(octokit, run.eventName, run.payload, {
        workflowId: run.id,
        createdAt: run.createdAt,
        checkRunId: run.checkRunId,
        installationId,
        installationToken,
        recordWorkflowTarget: (record) => this.store.recordWorkflowTarget(run.id, record),
        recordCheckRun: (record) => this.store.recordCheckRun(run.id, record),
        findActiveReview: (record) => this.store.findActiveReviewWorkflow(run.id, run.createdAt, record),
        enqueueSynthetic: (eventName, dedupeKey, payload, delayMs) =>
          this.enqueueSynthetic(eventName, dedupeKey, payload, delayMs),
        reviewFindingStore: {
          listOpenReviewFindings: (repoFullName, prNumber) =>
            this.store.listOpenReviewFindings(repoFullName, prNumber),
          upsertReviewFinding: (repoFullName, prNumber, finding) =>
            this.store.upsertReviewFinding(repoFullName, prNumber, finding),
          markReviewFindingResolved: (repoFullName, prNumber, fingerprint) =>
            this.store.markReviewFindingResolved(repoFullName, prNumber, fingerprint),
        },
        reviewGateFindingStore: {
          listReviewGateFindings: (repoFullName, prNumber) =>
            this.store.listReviewGateFindings(repoFullName, prNumber),
          upsertReviewGateFinding: (repoFullName, prNumber, record) =>
            this.store.upsertReviewGateFinding(repoFullName, prNumber, record),
        },
        findCachedReviewGateRun: (repoFullName, prNumber, headSha, promptVersion, contextSha256) =>
          this.store.findCachedReviewGateRun(
            repoFullName,
            prNumber,
            headSha,
            promptVersion,
            contextSha256,
          ),
        recordReviewRun: (record) => this.store.recordReviewRun(run.id, record),
      });
      await this.store.complete(run.id);
      metrics.recordWorkflowCompleted(run.eventName, elapsedSecondsSince(startedAt));
      this.logger.info({ workflowId: run.id, event: run.eventName }, "workflow completed");
    } catch (error) {
      if (isAiProviderCooldownError(error)) {
        await this.store.deferForProviderCooldown(run, error.retryAfterMs, error.message);
        this.logger.warn(
          {
            workflowId: run.id,
            event: run.eventName,
            attempt: run.attempts,
            maxAttempts: run.maxAttempts,
            retryAfterMs: error.retryAfterMs,
          },
          "workflow deferred because all AI providers are cooling down",
        );
        return true;
      }

      await this.store.fail(run, error);
      metrics.recordWorkflowFailed(run.eventName, run.attempts >= run.maxAttempts, elapsedSecondsSince(startedAt));
      this.logger.error(
        {
          error,
          workflowId: run.id,
          event: run.eventName,
          attempt: run.attempts,
          maxAttempts: run.maxAttempts,
        },
        "workflow failed",
      );
    }

    return true;
  }

  private async createInstallationToken(installationId: number): Promise<string | undefined> {
    try {
      const result = await (this.app as any).octokit.rest.apps.createInstallationAccessToken({
        installation_id: installationId,
      });
      return result.data.token;
    } catch (error) {
      this.logger.warn({ error }, "installation token unavailable for deep repo context");
      return undefined;
    }
  }

  private dedupeKey(eventName: string, event: WebhookEvent): string {
    if (event.id) {
      return event.id;
    }

    const payload = JSON.stringify(event.payload);
    return `${eventName}:${createHash("sha256").update(payload).digest("hex")}`;
  }
}

async function rollbackQuietly(connection: PoolConnection, logger: Logger): Promise<void> {
  try {
    await connection.rollback();
  } catch (error) {
    logger.warn({ error }, "workflow transaction rollback failed");
  }
}

function truncateError(value: string): string {
  return value.length > 65_000 ? `${value.slice(0, 64_000)}\n...truncated...` : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function elapsedSecondsSince(startedAtMs: number): number {
  return (Date.now() - startedAtMs) / 1000;
}

function repoFromWorkflowRun(run: ExpiredWorkflowRun): RepoRef | null {
  const fullName = run.repoFullName || run.payload.repository?.full_name || run.payload.repository?.fullName;
  if (!fullName || typeof fullName !== "string" || !fullName.includes("/")) {
    return null;
  }

  const [owner, repo] = fullName.split("/", 2);
  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    fullName,
    isPrivate: Boolean(run.payload.repository?.private),
  };
}

function activeWorkflowMetricFromRow(row: ActiveWorkflowMetricRow): ActiveWorkflowMetric {
  const payload = parsePayload(row.payload_json);
  const repoFullName = truncateMetricLabel(
    String(row.repo_full_name || payload.repository?.full_name || payload.repository?.fullName || "unknown"),
    160,
  );
  const prNumber = numberOrZero(
    row.pr_number
      ?? payload.pull_request?.number
      ?? payload.pullRequest?.number
      ?? payload.issue?.number
      ?? payload.ci_recheck?.pr_number
      ?? payload.ciRecheck?.prNumber,
  );
  const title = truncateMetricLabel(
    String(payload.pull_request?.title || payload.pullRequest?.title || payload.issue?.title || `PR #${prNumber}`),
    180,
  );
  const url = truncateMetricLabel(
    String(
      payload.pull_request?.html_url
        || payload.pullRequest?.htmlUrl
        || payload.issue?.html_url
        || (repoFullName !== "unknown" && prNumber > 0 ? `https://github.com/${repoFullName}/pull/${prNumber}` : ""),
    ),
    240,
  );

  return {
    workflowId: numberOrZero(row.id),
    status: row.status,
    eventName: row.event_name,
    repoFullName,
    prNumber,
    title,
    url: url || "unknown",
    headSha: truncateMetricLabel(String(row.head_sha || payload.pull_request?.head?.sha || payload.pullRequest?.head?.sha || ""), 64),
    checkKind: row.check_kind || "none",
    attempts: numberOrZero(row.attempts),
    ageSeconds: Number(row.age_seconds || 0),
    nextRunDelaySeconds: Number(row.next_run_delay_seconds || 0),
  };
}

function parsePayload(payloadJson: string): any {
  try {
    return JSON.parse(payloadJson);
  } catch {
    return {};
  }
}

function numberOrZero(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function truncateMetricLabel(value: string, maxLength: number): string {
  const trimmed = value.replaceAll(/\s+/g, " ").trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
}
