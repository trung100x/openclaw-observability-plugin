/**
 * OTLP File Exporter — writes telemetry signals as JSON Lines (.jsonl) to
 * a file (one per signal type) or to stdout. Conforms to the OpenTelemetry
 * Protocol File Exporter specification:
 * https://opentelemetry.io/docs/specs/otel/protocol/file-exporter/
 *
 * Each exported batch is appended as one JSON object per line:
 *   traces  → {dir}/traces.jsonl   ({"resourceSpans":  [...]})
 *   metrics → {dir}/metrics.jsonl  ({"resourceMetrics": [...]})
 *   logs    → {dir}/logs.jsonl     ({"resourceLogs":    [...]})
 *
 * When `dir` is undefined the output goes to stdout (the spec-mandated
 * default output stream).
 */

import fs from "node:fs";
import path from "node:path";

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { HrTime } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import type {
  PushMetricExporter,
  ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  AggregationTemporality,
  DataPointType,
  InstrumentType,
} from "@opentelemetry/sdk-metrics";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";

// ── Configuration ──────────────────────────────────────────────────────────

export interface FileExporterConfig {
  /**
   * Directory to write signal files into. When undefined the exporter
   * writes to stdout (the spec-defined default output stream).
   */
  dir?: string;
}

// ── OTLP attribute value encoding ─────────────────────────────────────────

type OtlpValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { bytesValue: string }
  | { arrayValue: { values: OtlpValue[] } }
  | { kvlistValue: { values: { key: string; value: OtlpValue }[] } };

function encodeValue(val: unknown): OtlpValue {
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "boolean") return { boolValue: val };
  if (typeof val === "number") {
    return Number.isInteger(val) ? { intValue: String(val) } : { doubleValue: val };
  }
  if (val instanceof Uint8Array) {
    return { bytesValue: Buffer.from(val).toString("base64") };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(encodeValue) } };
  }
  if (val !== null && val !== undefined && typeof val === "object") {
    return {
      kvlistValue: {
        values: Object.entries(val as Record<string, unknown>).map(([k, v]) => ({
          key: k,
          value: encodeValue(v),
        })),
      },
    };
  }
  return { stringValue: String(val ?? "") };
}

function encodeAttrs(
  attrs: Record<string, unknown> | undefined | null,
): { key: string; value: OtlpValue }[] {
  if (!attrs) return [];
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: encodeValue(value),
  }));
}

// ── HrTime → nanosecond uint64 string ─────────────────────────────────────

function hrNanos(t: HrTime): string {
  return String(BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]));
}

// ── Resource encoding ──────────────────────────────────────────────────────

function encodeResource(attrs: Record<string, unknown>): {
  attributes: { key: string; value: OtlpValue }[];
} {
  return { attributes: encodeAttrs(attrs) };
}

// ── Trace encoding ─────────────────────────────────────────────────────────

function spansToOtlp(spans: ReadableSpan[]): unknown {
  type ScopeEntry = {
    scope: { name: string; version: string };
    spans: Record<string, unknown>[];
  };
  type ResourceEntry = {
    resource: ReturnType<typeof encodeResource>;
    scopeMap: Map<string, ScopeEntry>;
  };

  const resMap = new Map<string, ResourceEntry>();

  for (const span of spans) {
    const rKey = JSON.stringify(span.resource.attributes);
    if (!resMap.has(rKey)) {
      resMap.set(rKey, {
        resource: encodeResource(span.resource.attributes as Record<string, unknown>),
        scopeMap: new Map(),
      });
    }
    const { scopeMap } = resMap.get(rKey)!;

    const scope = span.instrumentationScope;
    const sKey = `${scope.name}\0${scope.version ?? ""}`;
    if (!scopeMap.has(sKey)) {
      scopeMap.set(sKey, {
        scope: { name: scope.name, version: scope.version ?? "" },
        spans: [],
      });
    }

    const ctx = span.spanContext();
    const encoded: Record<string, unknown> = {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      name: span.name,
      // OTel SpanKind 0-4 maps to OTLP SpanKind 1-5
      kind: span.kind + 1,
      startTimeUnixNano: hrNanos(span.startTime),
      endTimeUnixNano: hrNanos(span.endTime),
      attributes: encodeAttrs(span.attributes as Record<string, unknown>),
      droppedAttributesCount: span.droppedAttributesCount,
      events: span.events.map((e) => ({
        timeUnixNano: hrNanos(e.time),
        name: e.name,
        attributes: encodeAttrs(e.attributes as Record<string, unknown>),
        droppedAttributesCount: e.droppedAttributesCount ?? 0,
      })),
      droppedEventsCount: span.droppedEventsCount,
      links: span.links.map((l) => ({
        traceId: l.context.traceId,
        spanId: l.context.spanId,
        attributes: encodeAttrs(l.attributes as Record<string, unknown>),
        droppedAttributesCount: 0,
      })),
      droppedLinksCount: span.droppedLinksCount,
      status: {
        code: span.status.code,
        ...(span.status.message ? { message: span.status.message } : {}),
      },
    };
    if (span.parentSpanContext) encoded.parentSpanId = span.parentSpanContext.spanId;
    const ts = ctx.traceState?.serialize();
    if (ts) encoded.traceState = ts;

    scopeMap.get(sKey)!.spans.push(encoded);
  }

  return {
    resourceSpans: Array.from(resMap.values()).map(({ resource, scopeMap }) => ({
      resource,
      scopeSpans: Array.from(scopeMap.values()).map(({ scope, spans }) => ({
        scope,
        spans,
      })),
    })),
  };
}

// ── Metrics encoding ───────────────────────────────────────────────────────

// OTel SDK AggregationTemporality (DELTA=0, CUMULATIVE=1)
// → OTLP proto (DELTA=1, CUMULATIVE=2)
function encodeTemporality(t: AggregationTemporality): number {
  return t + 1;
}

function encodeExemplars(exemplars: unknown[]): unknown[] {
  return exemplars.map((e: any) => ({
    filteredAttributes: encodeAttrs(e.filteredAttributes),
    timeUnixNano: hrNanos(e.hrTime ?? [0, 0]),
    asDouble: e.value,
    ...(e.spanId ? { spanId: e.spanId } : {}),
    ...(e.traceId ? { traceId: e.traceId } : {}),
  }));
}

function encodeMetric(metric: any): unknown {
  const base = {
    name: metric.descriptor.name,
    description: metric.descriptor.description ?? "",
    unit: metric.descriptor.unit ?? "",
  };

  if (metric.dataPointType === DataPointType.GAUGE) {
    return {
      ...base,
      gauge: {
        dataPoints: metric.dataPoints.map((dp: any) => ({
          attributes: encodeAttrs(dp.attributes),
          startTimeUnixNano: hrNanos(dp.startTime),
          timeUnixNano: hrNanos(dp.endTime),
          asDouble: dp.value,
          exemplars: encodeExemplars(dp.exemplars ?? []),
        })),
      },
    };
  }

  if (metric.dataPointType === DataPointType.SUM) {
    return {
      ...base,
      sum: {
        isMonotonic: metric.isMonotonic,
        aggregationTemporality: encodeTemporality(metric.aggregationTemporality),
        dataPoints: metric.dataPoints.map((dp: any) => ({
          attributes: encodeAttrs(dp.attributes),
          startTimeUnixNano: hrNanos(dp.startTime),
          timeUnixNano: hrNanos(dp.endTime),
          asDouble: dp.value,
          exemplars: encodeExemplars(dp.exemplars ?? []),
        })),
      },
    };
  }

  if (metric.dataPointType === DataPointType.HISTOGRAM) {
    return {
      ...base,
      histogram: {
        aggregationTemporality: encodeTemporality(metric.aggregationTemporality),
        dataPoints: metric.dataPoints.map((dp: any) => {
          const h = dp.value;
          return {
            attributes: encodeAttrs(dp.attributes),
            startTimeUnixNano: hrNanos(dp.startTime),
            timeUnixNano: hrNanos(dp.endTime),
            count: String(h.count),
            ...(h.sum !== undefined ? { sum: h.sum } : {}),
            ...(h.min !== undefined ? { min: h.min } : {}),
            ...(h.max !== undefined ? { max: h.max } : {}),
            bucketCounts: h.buckets.counts.map(String),
            explicitBounds: h.buckets.boundaries,
            exemplars: encodeExemplars(dp.exemplars ?? []),
          };
        }),
      },
    };
  }

  return base;
}

function metricsToOtlp(rm: ResourceMetrics): unknown {
  return {
    resourceMetrics: [
      {
        resource: encodeResource(rm.resource.attributes as Record<string, unknown>),
        scopeMetrics: rm.scopeMetrics.map((sm) => ({
          scope: { name: sm.scope.name, version: sm.scope.version ?? "" },
          metrics: sm.metrics.map(encodeMetric),
        })),
      },
    ],
  };
}

// ── Logs encoding ──────────────────────────────────────────────────────────

function logsToOtlp(logRecords: ReadableLogRecord[]): unknown {
  type ScopeEntry = {
    scope: { name: string; version: string };
    logRecords: unknown[];
  };
  type ResourceEntry = {
    resource: ReturnType<typeof encodeResource>;
    scopeMap: Map<string, ScopeEntry>;
  };

  const resMap = new Map<string, ResourceEntry>();

  for (const log of logRecords) {
    const rKey = JSON.stringify(log.resource.attributes);
    if (!resMap.has(rKey)) {
      resMap.set(rKey, {
        resource: encodeResource(log.resource.attributes as Record<string, unknown>),
        scopeMap: new Map(),
      });
    }
    const { scopeMap } = resMap.get(rKey)!;

    const scope = log.instrumentationScope;
    const sKey = `${scope.name}\0${scope.version ?? ""}`;
    if (!scopeMap.has(sKey)) {
      scopeMap.set(sKey, {
        scope: { name: scope.name, version: scope.version ?? "" },
        logRecords: [],
      });
    }

    const record: Record<string, unknown> = {
      timeUnixNano: hrNanos(log.hrTime),
      observedTimeUnixNano: hrNanos(log.hrTimeObserved),
      severityNumber: log.severityNumber ?? 0,
      severityText: log.severityText ?? "",
      attributes: encodeAttrs(log.attributes as Record<string, unknown>),
      droppedAttributesCount: log.droppedAttributesCount,
    };
    if (log.body !== undefined && log.body !== null) {
      record.body = encodeValue(log.body);
    }
    const ctx = log.spanContext;
    if (ctx) {
      if (ctx.traceId) record.traceId = ctx.traceId;
      if (ctx.spanId) record.spanId = ctx.spanId;
      record.flags = ctx.traceFlags ?? 0;
    }

    scopeMap.get(sKey)!.logRecords.push(record);
  }

  return {
    resourceLogs: Array.from(resMap.values()).map(({ resource, scopeMap }) => ({
      resource,
      scopeLogs: Array.from(scopeMap.values()).map(({ scope, logRecords }) => ({
        scope,
        logRecords,
      })),
    })),
  };
}

// ── Output stream ──────────────────────────────────────────────────────────

interface OutputStream {
  writeLine(payload: string): void;
  close(): void;
}

function openStream(dir: string | undefined, filename: string): OutputStream {
  if (dir === undefined) {
    return {
      writeLine: (line) => {
        process.stdout.write(line + "\n");
      },
      close: () => {},
    };
  }
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(path.join(dir, filename), "a");
  let closed = false;
  return {
    writeLine: (line) => {
      if (!closed) fs.writeSync(fd, line + "\n");
    },
    close: () => {
      if (!closed) {
        closed = true;
        fs.closeSync(fd);
      }
    },
  };
}

// ── Exporters ──────────────────────────────────────────────────────────────

export class FileTraceExporter implements SpanExporter {
  private readonly out: OutputStream;

  constructor(config: FileExporterConfig = {}) {
    this.out = openStream(config.dir, "traces.jsonl");
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      this.out.writeLine(JSON.stringify(spansToOtlp(spans)));
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  shutdown(): Promise<void> {
    this.out.close();
    return Promise.resolve();
  }
}

export class FileMetricExporter implements PushMetricExporter {
  private readonly out: OutputStream;

  constructor(config: FileExporterConfig = {}) {
    this.out = openStream(config.dir, "metrics.jsonl");
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    try {
      this.out.writeLine(JSON.stringify(metricsToOtlp(metrics)));
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  selectAggregationTemporality(_instrumentType: InstrumentType): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }

  shutdown(): Promise<void> {
    this.out.close();
    return Promise.resolve();
  }
}

export class FileLogExporter implements LogRecordExporter {
  private readonly out: OutputStream;

  constructor(config: FileExporterConfig = {}) {
    this.out = openStream(config.dir, "logs.jsonl");
  }

  export(logRecords: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    try {
      this.out.writeLine(JSON.stringify(logsToOtlp(logRecords)));
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  shutdown(): Promise<void> {
    this.out.close();
    return Promise.resolve();
  }
}
