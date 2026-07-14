export type MetricLabels = Record<string, string | number | boolean | null | undefined>;

export type GaugeSample = {
  name: string;
  labels?: MetricLabels;
  value: number;
};

export type WorkflowQueueMetric = {
  status: string;
  eventName: string;
  count: number;
  readyCount: number;
  oldestAgeSeconds: number;
};

export type ActiveWorkflowMetric = {
  workflowId: number;
  status: string;
  eventName: string;
  repoFullName: string;
  prNumber: number;
  title: string;
  url: string;
  headSha: string;
  checkKind: string;
  attempts: number;
  ageSeconds: number;
  nextRunDelaySeconds: number;
};

type CounterSeries = {
  labels: Record<string, string>;
  value: number;
};

type HistogramSeries = {
  labels: Record<string, string>;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
};

const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const METADATA: Record<string, { type: "counter" | "gauge" | "histogram"; help: string }> = {
  seori_pr_bot_info: {
    type: "gauge",
    help: "Static seori-pr-bot process information.",
  },
  seori_pr_bot_process_uptime_seconds: {
    type: "gauge",
    help: "Seconds since the seori-pr-bot process started.",
  },
  seori_pr_bot_webhook_requests_total: {
    type: "counter",
    help: "GitHub webhook HTTP requests handled by outcome.",
  },
  seori_pr_bot_workflows_enqueued_total: {
    type: "counter",
    help: "Workflow enqueue attempts by event, source, and result.",
  },
  seori_pr_bot_workflows_leased_total: {
    type: "counter",
    help: "Workflow runs leased by the worker.",
  },
  seori_pr_bot_workflows_completed_total: {
    type: "counter",
    help: "Workflow runs completed successfully.",
  },
  seori_pr_bot_workflows_failed_total: {
    type: "counter",
    help: "Workflow runs that failed, split by retry/final outcome.",
  },
  seori_pr_bot_workflow_run_duration_seconds: {
    type: "histogram",
    help: "Workflow run processing duration in seconds.",
  },
  seori_pr_bot_workflow_rows: {
    type: "gauge",
    help: "Workflow rows currently stored in MySQL by status and event.",
  },
  seori_pr_bot_workflow_ready_rows: {
    type: "gauge",
    help: "Queued workflow rows ready to be leased now.",
  },
  seori_pr_bot_workflow_oldest_row_age_seconds: {
    type: "gauge",
    help: "Age in seconds of the oldest workflow row by status and event.",
  },
  seori_pr_bot_active_pr_info: {
    type: "gauge",
    help: "Active queued or running PR workflow information. Labels include repo, PR number, title, URL, status, and event.",
  },
  seori_pr_bot_active_pr_age_seconds: {
    type: "gauge",
    help: "Age in seconds for active queued or running PR workflows. Labels identify the PR workflow.",
  },
  seori_pr_bot_active_pr_next_run_delay_seconds: {
    type: "gauge",
    help: "Seconds until the next run time for active queued PR workflows. Running workflows report zero.",
  },
  seori_pr_bot_ai_provider_attempts_total: {
    type: "counter",
    help: "AI provider attempts by task kind, selected provider, provider, and outcome.",
  },
  seori_pr_bot_ai_provider_duration_seconds: {
    type: "histogram",
    help: "AI provider call duration in seconds.",
  },
  seori_pr_bot_ai_provider_configured: {
    type: "gauge",
    help: "Whether an AI provider is used by normal routing or second-opinion review.",
  },
  seori_pr_bot_ai_provider_weight: {
    type: "gauge",
    help: "Configured AI provider routing weight.",
  },
  seori_pr_bot_ai_provider_credential_present: {
    type: "gauge",
    help: "Whether required credentials appear present for the AI provider.",
  },
  seori_pr_bot_ai_provider_routing_enabled: {
    type: "gauge",
    help: "Whether an AI provider can be selected by routing based on config weight.",
  },
  seori_pr_bot_ai_provider_second_opinion_enabled: {
    type: "gauge",
    help: "Whether an AI provider is configured for direct second-opinion review.",
  },
  seori_pr_bot_ai_provider_available: {
    type: "gauge",
    help: "Whether an AI provider is usable by routing or second-opinion review right now.",
  },
  seori_pr_bot_ai_provider_cooldown_remaining_seconds: {
    type: "gauge",
    help: "Seconds remaining until the AI provider cooldown expires in this process.",
  },
  seori_pr_bot_ai_provider_cooldown_until_timestamp_seconds: {
    type: "gauge",
    help: "Unix timestamp when the AI provider cooldown expires in this process.",
  },
  seori_pr_bot_ai_provider_last_success_timestamp_seconds: {
    type: "gauge",
    help: "Unix timestamp of the last successful AI provider response in this process.",
  },
  seori_pr_bot_ai_provider_last_failure_timestamp_seconds: {
    type: "gauge",
    help: "Unix timestamp of the last AI provider failure in this process.",
  },
  seori_pr_bot_ai_provider_last_quota_reset_timestamp_seconds: {
    type: "gauge",
    help: "Unix timestamp of the last quota reset time reported by an AI provider in this process.",
  },
  seori_pr_bot_check_runs_started_total: {
    type: "counter",
    help: "GitHub check runs started by kind.",
  },
  seori_pr_bot_check_runs_completed_total: {
    type: "counter",
    help: "GitHub check runs completed by kind and conclusion.",
  },
  seori_pr_bot_active_tasks: {
    type: "gauge",
    help: "Background webhook tasks currently running in this process.",
  },
  seori_pr_bot_active_check_runs: {
    type: "gauge",
    help: "Tracked GitHub check runs currently active in this process.",
  },
};

const WORKFLOW_DURATION_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1200];
const AI_PROVIDER_DURATION_BUCKETS = [1, 5, 15, 30, 60, 120, 180, 300];

export class MetricsRegistry {
  private readonly counters = new Map<string, CounterSeries>();
  private readonly histograms = new Map<string, HistogramSeries>();
  private readonly startedAtMs = Date.now();

  recordWebhookRequest(event: string, outcome: string): void {
    this.increment("seori_pr_bot_webhook_requests_total", { event: normalizeLabel(event), outcome });
  }

  recordWorkflowEnqueued(event: string, source: "webhook" | "synthetic", inserted: boolean): void {
    this.increment("seori_pr_bot_workflows_enqueued_total", {
      event,
      source,
      result: inserted ? "inserted" : "duplicate",
    });
  }

  recordWorkflowLeased(event: string): void {
    this.increment("seori_pr_bot_workflows_leased_total", { event });
  }

  recordWorkflowCompleted(event: string, durationSeconds: number): void {
    this.increment("seori_pr_bot_workflows_completed_total", { event });
    this.observe("seori_pr_bot_workflow_run_duration_seconds", { event, outcome: "completed" }, durationSeconds, WORKFLOW_DURATION_BUCKETS);
  }

  recordWorkflowFailed(event: string, final: boolean, durationSeconds: number): void {
    const outcome = final ? "failed_final" : "failed_retry";
    this.increment("seori_pr_bot_workflows_failed_total", { event, outcome });
    this.observe("seori_pr_bot_workflow_run_duration_seconds", { event, outcome }, durationSeconds, WORKFLOW_DURATION_BUCKETS);
  }

  recordAiProviderAttempt(
    kind: string,
    selectedProvider: string,
    provider: string,
    outcome: "success" | "failure" | "cooldown",
    durationSeconds?: number,
  ): void {
    const labels = {
      kind,
      selected_provider: selectedProvider,
      provider,
      outcome,
    };
    this.increment("seori_pr_bot_ai_provider_attempts_total", labels);
    if (typeof durationSeconds === "number") {
      this.observe("seori_pr_bot_ai_provider_duration_seconds", labels, durationSeconds, AI_PROVIDER_DURATION_BUCKETS);
    }
  }

  recordCheckRunStarted(kind: string): void {
    this.increment("seori_pr_bot_check_runs_started_total", { kind });
  }

  recordCheckRunCompleted(kind: string, conclusion: string): void {
    this.increment("seori_pr_bot_check_runs_completed_total", { kind, conclusion });
  }

  render(options: {
    infoLabels?: MetricLabels;
    gauges?: GaugeSample[];
    workflowQueue?: WorkflowQueueMetric[];
    activeWorkflows?: ActiveWorkflowMetric[];
  } = {}): string {
    const samples: string[] = [];
    const used = new Set<string>();

    samples.push(this.metadata("seori_pr_bot_info"));
    samples.push(metricLine("seori_pr_bot_info", normalizeLabels(options.infoLabels || {}), 1));
    used.add("seori_pr_bot_info");

    samples.push(this.metadata("seori_pr_bot_process_uptime_seconds"));
    samples.push(metricLine("seori_pr_bot_process_uptime_seconds", {}, (Date.now() - this.startedAtMs) / 1000));
    used.add("seori_pr_bot_process_uptime_seconds");

    for (const [name, group] of this.groupCounters()) {
      samples.push(this.metadata(name));
      used.add(name);
      for (const series of group) {
        samples.push(metricLine(name, series.labels, series.value));
      }
    }

    for (const [name, group] of this.groupHistograms()) {
      samples.push(this.metadata(name));
      used.add(name);
      for (const series of group) {
        for (let index = 0; index < series.buckets.length; index += 1) {
          samples.push(metricLine(`${name}_bucket`, { ...series.labels, le: String(series.buckets[index]) }, series.counts[index] || 0));
        }
        samples.push(metricLine(`${name}_bucket`, { ...series.labels, le: "+Inf" }, series.count));
        samples.push(metricLine(`${name}_sum`, series.labels, series.sum));
        samples.push(metricLine(`${name}_count`, series.labels, series.count));
      }
    }

    for (const metric of this.workflowQueueGauges(options.workflowQueue || [])) {
      if (!used.has(metric.name)) {
        samples.push(this.metadata(metric.name));
        used.add(metric.name);
      }
      samples.push(metricLine(metric.name, normalizeLabels(metric.labels || {}), metric.value));
    }

    for (const metric of this.activeWorkflowGauges(options.activeWorkflows || [])) {
      if (!used.has(metric.name)) {
        samples.push(this.metadata(metric.name));
        used.add(metric.name);
      }
      samples.push(metricLine(metric.name, normalizeLabels(metric.labels || {}), metric.value));
    }

    for (const gauge of options.gauges || []) {
      if (!used.has(gauge.name)) {
        samples.push(this.metadata(gauge.name));
        used.add(gauge.name);
      }
      samples.push(metricLine(gauge.name, normalizeLabels(gauge.labels || {}), gauge.value));
    }

    return `${samples.join("\n")}\n`;
  }

  private increment(name: string, labels: MetricLabels, value = 1): void {
    const normalized = normalizeLabels(labels);
    const key = seriesKey(name, normalized);
    const series = this.counters.get(key) || { labels: normalized, value: 0 };
    series.value += value;
    this.counters.set(key, series);
  }

  private observe(name: string, labels: MetricLabels, value: number, buckets: number[]): void {
    if (!Number.isFinite(value) || value < 0) {
      return;
    }

    const normalized = normalizeLabels(labels);
    const key = seriesKey(name, normalized);
    let series = this.histograms.get(key);
    if (!series) {
      series = {
        labels: normalized,
        buckets,
        counts: new Array(buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.histograms.set(key, series);
    }

    series.sum += value;
    series.count += 1;
    for (let index = 0; index < series.buckets.length; index += 1) {
      if (value <= series.buckets[index]!) {
        series.counts[index] = (series.counts[index] || 0) + 1;
      }
    }
  }

  private groupCounters(): Map<string, CounterSeries[]> {
    const grouped = new Map<string, CounterSeries[]>();
    for (const [key, series] of this.counters) {
      const name = key.slice(0, key.indexOf("{"));
      grouped.set(name, [...(grouped.get(name) || []), series]);
    }
    return grouped;
  }

  private groupHistograms(): Map<string, HistogramSeries[]> {
    const grouped = new Map<string, HistogramSeries[]>();
    for (const [key, series] of this.histograms) {
      const name = key.slice(0, key.indexOf("{"));
      grouped.set(name, [...(grouped.get(name) || []), series]);
    }
    return grouped;
  }

  private workflowQueueGauges(rows: WorkflowQueueMetric[]): GaugeSample[] {
    const samples: GaugeSample[] = [];
    for (const row of rows) {
      samples.push(
        {
          name: "seori_pr_bot_workflow_rows",
          labels: { status: row.status, event: row.eventName },
          value: row.count,
        },
        {
          name: "seori_pr_bot_workflow_oldest_row_age_seconds",
          labels: { status: row.status, event: row.eventName },
          value: row.oldestAgeSeconds,
        },
      );

      if (row.status === "queued") {
        samples.push({
          name: "seori_pr_bot_workflow_ready_rows",
          labels: { event: row.eventName },
          value: row.readyCount,
        });
      }
    }
    return samples;
  }

  private activeWorkflowGauges(rows: ActiveWorkflowMetric[]): GaugeSample[] {
    const samples: GaugeSample[] = [];
    for (const row of rows) {
      const labels = {
        workflow_id: row.workflowId,
        status: row.status,
        event: row.eventName,
        repo: row.repoFullName,
        pr_number: row.prNumber,
        title: row.title,
        url: row.url,
        head_sha: row.headSha,
        check_kind: row.checkKind,
        attempts: row.attempts,
      };
      samples.push(
        {
          name: "seori_pr_bot_active_pr_info",
          labels,
          value: 1,
        },
        {
          name: "seori_pr_bot_active_pr_age_seconds",
          labels,
          value: row.ageSeconds,
        },
        {
          name: "seori_pr_bot_active_pr_next_run_delay_seconds",
          labels,
          value: row.nextRunDelaySeconds,
        },
      );
    }
    return samples;
  }

  private metadata(name: string): string {
    const metadata = METADATA[name] || { type: "gauge" as const, help: name };
    return [`# HELP ${name} ${metadata.help}`, `# TYPE ${name} ${metadata.type}`].join("\n");
  }
}

export const metrics = new MetricsRegistry();

export function metricsContentType(): string {
  return CONTENT_TYPE;
}

function metricLine(name: string, labels: Record<string, string>, value: number): string {
  const labelText = Object.keys(labels).length > 0
    ? `{${Object.entries(labels).map(([key, labelValue]) => `${key}="${escapeLabel(labelValue)}"`).join(",")}}`
    : "";
  const safeValue = Number.isFinite(value) ? value : 0;
  return `${name}${labelText} ${safeValue}`;
}

function normalizeLabels(labels: MetricLabels): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels)
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, normalizeLabel(String(value))]),
  );
}

function normalizeLabel(value: string): string {
  return value.trim() || "unknown";
}

function seriesKey(name: string, labels: Record<string, string>): string {
  return `${name}{${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",")}}`;
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\"", "\\\"");
}
