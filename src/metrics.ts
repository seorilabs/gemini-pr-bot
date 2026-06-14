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
  gemini_pr_bot_info: {
    type: "gauge",
    help: "Static gemini-pr-bot process information.",
  },
  gemini_pr_bot_process_uptime_seconds: {
    type: "gauge",
    help: "Seconds since the gemini-pr-bot process started.",
  },
  gemini_pr_bot_webhook_requests_total: {
    type: "counter",
    help: "GitHub webhook HTTP requests handled by outcome.",
  },
  gemini_pr_bot_workflows_enqueued_total: {
    type: "counter",
    help: "Workflow enqueue attempts by event, source, and result.",
  },
  gemini_pr_bot_workflows_leased_total: {
    type: "counter",
    help: "Workflow runs leased by the worker.",
  },
  gemini_pr_bot_workflows_completed_total: {
    type: "counter",
    help: "Workflow runs completed successfully.",
  },
  gemini_pr_bot_workflows_failed_total: {
    type: "counter",
    help: "Workflow runs that failed, split by retry/final outcome.",
  },
  gemini_pr_bot_workflow_run_duration_seconds: {
    type: "histogram",
    help: "Workflow run processing duration in seconds.",
  },
  gemini_pr_bot_workflow_rows: {
    type: "gauge",
    help: "Workflow rows currently stored in MySQL by status and event.",
  },
  gemini_pr_bot_workflow_ready_rows: {
    type: "gauge",
    help: "Queued workflow rows ready to be leased now.",
  },
  gemini_pr_bot_workflow_oldest_row_age_seconds: {
    type: "gauge",
    help: "Age in seconds of the oldest workflow row by status and event.",
  },
  gemini_pr_bot_ai_provider_attempts_total: {
    type: "counter",
    help: "AI provider attempts by task kind, selected provider, provider, and outcome.",
  },
  gemini_pr_bot_ai_provider_duration_seconds: {
    type: "histogram",
    help: "AI provider call duration in seconds.",
  },
  gemini_pr_bot_check_runs_started_total: {
    type: "counter",
    help: "GitHub check runs started by kind.",
  },
  gemini_pr_bot_check_runs_completed_total: {
    type: "counter",
    help: "GitHub check runs completed by kind and conclusion.",
  },
  gemini_pr_bot_active_tasks: {
    type: "gauge",
    help: "Background webhook tasks currently running in this process.",
  },
  gemini_pr_bot_active_check_runs: {
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
    this.increment("gemini_pr_bot_webhook_requests_total", { event: normalizeLabel(event), outcome });
  }

  recordWorkflowEnqueued(event: string, source: "webhook" | "synthetic", inserted: boolean): void {
    this.increment("gemini_pr_bot_workflows_enqueued_total", {
      event,
      source,
      result: inserted ? "inserted" : "duplicate",
    });
  }

  recordWorkflowLeased(event: string): void {
    this.increment("gemini_pr_bot_workflows_leased_total", { event });
  }

  recordWorkflowCompleted(event: string, durationSeconds: number): void {
    this.increment("gemini_pr_bot_workflows_completed_total", { event });
    this.observe("gemini_pr_bot_workflow_run_duration_seconds", { event, outcome: "completed" }, durationSeconds, WORKFLOW_DURATION_BUCKETS);
  }

  recordWorkflowFailed(event: string, final: boolean, durationSeconds: number): void {
    const outcome = final ? "failed_final" : "failed_retry";
    this.increment("gemini_pr_bot_workflows_failed_total", { event, outcome });
    this.observe("gemini_pr_bot_workflow_run_duration_seconds", { event, outcome }, durationSeconds, WORKFLOW_DURATION_BUCKETS);
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
    this.increment("gemini_pr_bot_ai_provider_attempts_total", labels);
    if (typeof durationSeconds === "number") {
      this.observe("gemini_pr_bot_ai_provider_duration_seconds", labels, durationSeconds, AI_PROVIDER_DURATION_BUCKETS);
    }
  }

  recordCheckRunStarted(kind: string): void {
    this.increment("gemini_pr_bot_check_runs_started_total", { kind });
  }

  recordCheckRunCompleted(kind: string, conclusion: string): void {
    this.increment("gemini_pr_bot_check_runs_completed_total", { kind, conclusion });
  }

  render(options: {
    infoLabels?: MetricLabels;
    gauges?: GaugeSample[];
    workflowQueue?: WorkflowQueueMetric[];
  } = {}): string {
    const samples: string[] = [];
    const used = new Set<string>();

    samples.push(this.metadata("gemini_pr_bot_info"));
    samples.push(metricLine("gemini_pr_bot_info", normalizeLabels(options.infoLabels || {}), 1));
    used.add("gemini_pr_bot_info");

    samples.push(this.metadata("gemini_pr_bot_process_uptime_seconds"));
    samples.push(metricLine("gemini_pr_bot_process_uptime_seconds", {}, (Date.now() - this.startedAtMs) / 1000));
    used.add("gemini_pr_bot_process_uptime_seconds");

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
          name: "gemini_pr_bot_workflow_rows",
          labels: { status: row.status, event: row.eventName },
          value: row.count,
        },
        {
          name: "gemini_pr_bot_workflow_oldest_row_age_seconds",
          labels: { status: row.status, event: row.eventName },
          value: row.oldestAgeSeconds,
        },
      );

      if (row.status === "queued") {
        samples.push({
          name: "gemini_pr_bot_workflow_ready_rows",
          labels: { event: row.eventName },
          value: row.readyCount,
        });
      }
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
