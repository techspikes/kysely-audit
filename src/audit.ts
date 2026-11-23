import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Dialect } from 'kysely'
import { MysqlDialect, PGliteDialect, PostgresDialect } from 'kysely'
import { wrapDialect } from './driver.ts'
import type { Observation, Observe } from './driver.ts'
import { analyze } from './query.ts'
import type { QueryPlan } from './query.ts'
import {
  hasShortUuidFormat, isUuidFormat, normalizeId, rangeSize, serialize,
  union, unionBounds,
} from './range.ts'
import type { Predicate } from './range.ts'
import type {
  AuditEvent, AuditOptions, TableConfig, ReturnedBounds, TableSummary,
} from './types.ts'

const windowLength = 15 * 60 * 1000
const rangeLimit = 10_000

interface OtelApi {
  trace: { getActiveSpan(): { spanContext(): { traceId: string; spanId: string } } | undefined }
  isSpanContextValid(span: { traceId: string; spanId: string }): boolean
}

function loadOtel (): OtelApi | undefined {
  const require = createRequire(import.meta.url)

  try {
    return require('@opentelemetry/api') as OtelApi
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND')) { throw error }
  }
}

function activeTraceId (otel: OtelApi | undefined): string | null {
  const span = otel?.trace.getActiveSpan()?.spanContext()

  return span && otel?.isSpanContextValid(span) ? span.traceId : null
}

function tableIdentifier ({ table, schema }: TableConfig): string {
  // Quoting preserves the boundaries of identifiers that contain a dot or quote.
  const quote = (part: string) => /[."]/.test(part) ? '"' + part.replaceAll('"', '""') + '"' : part

  return schema === undefined ? quote(table) : quote(schema) + '.' + quote(table)
}

type ObservedScope = {
  ids: Set<string> | null
  returnedBounds: ReturnedBounds | null
  predicate: Predicate | null
  unresolved: boolean
  overflow: boolean
}

function resolveScopes (plan: QueryPlan, rows: readonly unknown[], limit: number): ObservedScope[] {
  return plan.tables.map(({ table, occurrences }) => {
    const scope: ObservedScope = {
      ids: null, returnedBounds: null, predicate: null, unresolved: false, overflow: false,
    }

    const returnedKeyType = table.keyType === 'integer' ? 'integer' : 'string'
    const short = table.uuidFormat === 'short'

    let min: string | null = null
    let max: string | null = null

    for (const { columns, nullable, predicate } of occurrences) {
      let fallback = columns.length === 0

      if (columns.length > 0) {
        const ids = scope.ids ?? new Set<string>()
        let observed = rows.length === 0

        for (const row of rows) {
          const record = typeof row === 'object' && row !== null ? row as Record<string, unknown> : {}

          let recognized = false
          let invalidShortId = false

          for (const column of columns) {
            if (!Object.hasOwn(record, column)) { continue }

            const value = record[column]

            if (nullable && value === null) {
              recognized = true
              break
            }

            const id = normalizeId(value, returnedKeyType)

            if (short && !hasShortUuidFormat(id)) {
              invalidShortId = true
              continue
            }

            if (id === undefined) {
              continue
            }

            if (short) {
              if (min === null || id < min) {
                min = id
              }

              if (max === null || id > max) {
                max = id
              }
            }

            if (ids.size < limit || ids.has(id)) {
              ids.add(id)
            } else {
              scope.overflow = true
            }

            recognized = true
            break
          }

          observed ||= recognized

          if (!recognized && invalidShortId) {
            scope.unresolved = true
          } else {
            fallback ||= !recognized
          }
        }

        if (observed) { scope.ids = ids }
      }

      if (fallback) {
        if (predicate.kind === 'unknown') {
          scope.unresolved = true
        } else {
          scope.predicate = scope.predicate === null ? predicate : union(scope.predicate, predicate)
        }
      }
    }

    if (min !== null && max !== null) {
      scope.returnedBounds = [min, max]
    }

    return scope
  })
}

type Accumulator = {
  ids: Set<string>
  returnedBounds: ReturnedBounds | null
  predicate: Predicate | null
  returnedRows: number
  unresolvedObservations: number
  failedExecutions: number
  overflow: boolean
}

function addScope (summary: Accumulator, scope: ObservedScope): void {
  let overflow = scope.overflow

  if (scope.returnedBounds) {
    const [min, max] = scope.returnedBounds
    const current = summary.returnedBounds

    summary.returnedBounds = current
      ? [min < current[0] ? min : current[0], max > current[1] ? max : current[1]]
      : scope.returnedBounds
  }

  if (scope.ids) {
    const idLimit = rangeLimit - (summary.predicate ? rangeSize(summary.predicate) : 0)

    for (const id of scope.ids) {
      if (summary.ids.size < idLimit || summary.ids.has(id)) { summary.ids.add(id) } else { overflow = true }
    }
  }

  if (scope.predicate) {
    const predicate = unionBounds(summary.predicate, scope.predicate)

    if (rangeSize(predicate) + summary.ids.size <= rangeLimit) {
      summary.predicate = predicate
    } else {
      overflow = true
    }
  }

  summary.overflow ||= overflow

  if (scope.unresolved || overflow) {
    summary.unresolvedObservations++
  }
}

type Frame = {
  start: number
  tables: Map<TableConfig, Accumulator>
  unresolvedQueries: number
  unresolvedQueryFailures: number
}

function observationCounts (observation: Observation) {
  return {
    returnedRows: observation.rows?.length ?? 0,
    unresolvedObservations: !observation.rows && observation.status !== 'failed' ? 1 : 0,
    failedExecutions: observation.status === 'failed' ? 1 : 0,
  }
}

function tableSummary (table: TableConfig, entry: Accumulator): TableSummary {
  const pred = entry.predicate && serialize(entry.predicate, table)

  return {
    table: tableIdentifier(table),
    ...(entry.ids.size > 0 && { ids: [...entry.ids] }),
    ...(entry.returnedBounds && { bounds: entry.returnedBounds }),
    ...(pred && { pred }),
    ...(entry.returnedRows > 0 && { rows: entry.returnedRows }),
    ...(entry.unresolvedObservations > 0 && { miss: entry.unresolvedObservations }),
    ...(entry.failedExecutions > 0 && { fails: entry.failedExecutions }),
    ...(entry.overflow && { overflow: true }),
  }
}

function timestamp (time: number): string {
  return new Date(time).toISOString()
}

function validateTables (configured: readonly TableConfig[]): TableConfig[] {
  const seen = new Set<string>()

  return configured.map(config => {
    if (!config.table || !config.key || config.schema === '' ||
      !['integer', 'string', 'native-uuid', 'uuid'].includes(config.keyType)) {
      throw new TypeError('Invalid monitored table or key')
    }

    if (config.uuidFormat !== undefined && (config.keyType !== 'uuid' || !isUuidFormat(config.uuidFormat))) {
      throw new TypeError('uuidFormat requires keyType uuid and a valid text format')
    }

    const name = JSON.stringify([config.schema, config.table])

    if (seen.has(name)) {
      throw new TypeError('Duplicate monitored table')
    }

    seen.add(name)

    return { ...config }
  })
}

export interface Audit {
  wrapDialect(dialect: Dialect): Dialect
  close(): Promise<void>
}

function writeAuditEventToStdout (event: AuditEvent): void {
  writeFileSync(1, JSON.stringify(event) + '\n')
}

function reportAuditErrorToStderr (): void {
  writeFileSync(2, '{"level":"error","message":"Audit logging failed"}\n')
}

export function createAudit ({
  mode = 'standard',
  tables: configured,
  writeAuditEvent = writeAuditEventToStdout,
  onAuditError = reportAuditErrorToStderr,
}: AuditOptions): Audit {
  const tables = validateTables(configured)
  const otel = mode === 'detailed' ? loadOtel() : undefined
  const pending = new Set<Promise<void>>()

  let closing: Promise<void> | undefined = undefined
  let frame: Frame | undefined = undefined
  let timer: ReturnType<typeof setTimeout> | undefined = undefined

  async function report (error: unknown): Promise<void> {
    try {
      await onAuditError(error)
    } catch {
      // An audit error handler cannot interfere with queries.
    }
  }

  function track (completion: Promise<void>): void {
    pending.add(completion)
    completion.then(() => pending.delete(completion))
  }

  function dispatch (event: AuditEvent): void {
    try {
      const result = writeAuditEvent(event)

      if (result) {
        track(Promise.resolve(result).catch(report))
      }
    } catch (error) {
      track(report(error))
    }
  }

  function flush (now: number): void {
    clearTimeout(timer)
    timer = undefined

    const finished = frame
    frame = undefined

    if (!finished) {
      return
    }

    const end = finished.start + windowLength

    dispatch({
      at: timestamp(finished.start),
      ...(now < end && { end: timestamp(Math.max(finished.start, now)) }),
      ...(finished.tables.size > 0 && {
        tables: [...finished.tables].map(([table, entry]) => tableSummary(table, entry)),
      }),
      ...(finished.unresolvedQueries > 0 && { opaque: finished.unresolvedQueries }),
      ...(finished.unresolvedQueryFailures > 0 && { fails: finished.unresolvedQueryFailures }),
    })
  }

  function arm (start: number, now: number): void {
    const end = start + windowLength

    timer = setTimeout(() => {
      const current = Date.now()

      if (current >= end) {
        flush(current)
      } else {
        arm(start, current)
      }
    }, end - now)

    timer.unref?.()
  }

  function accumulate (now: number, plan: QueryPlan, observation: Observation, scopes: ObservedScope[]): void {
    // Start a window only for observations that contribute to it.
    const countUnresolved = plan.unresolved && observation.first
    const failedUnresolved = plan.unresolved && observation.status === 'failed'
    const countTables = observation.rows !== undefined || observation.status === 'failed' || observation.first

    if (!countUnresolved && !failedUnresolved && (!countTables || plan.tables.length === 0)) {
      return
    }

    const start = Math.floor(now / windowLength) * windowLength

    if (frame && frame.start !== start) {
      flush(now)
    }

    if (closing) {
      return
    }

    if (!frame) {
      frame = { start, tables: new Map(), unresolvedQueries: 0, unresolvedQueryFailures: 0 }
      arm(start, now)
    }

    if (countUnresolved) {
      frame.unresolvedQueries++
    }

    if (failedUnresolved) {
      frame.unresolvedQueryFailures++
    }

    if (!countTables) {
      return
    }

    const counts = observationCounts(observation)

    for (const [index, { table }] of plan.tables.entries()) {
      let summary = frame.tables.get(table)

      if (!summary) {
        summary = {
          ids: new Set(),
          returnedBounds: null,
          predicate: null,
          returnedRows: 0,
          unresolvedObservations: 0,
          failedExecutions: 0,
          overflow: false,
        }
        frame.tables.set(table, summary)
      }

      summary.returnedRows += counts.returnedRows
      summary.failedExecutions += counts.failedExecutions
      summary.unresolvedObservations += counts.unresolvedObservations

      const scope = scopes[index]

      if (scope) {
        addScope(summary, scope)
      }
    }
  }

  const observeFor = (comparisons: Parameters<typeof analyze>[2]): Observe => query => {
    if (closing) {
      return () => {}
    }

    let plan: QueryPlan | undefined = undefined

    try {
      plan = analyze(query.query, tables, comparisons)
    } catch (error) {
      track(report(error))
      plan = { tables: [], unresolved: true }
    }

    if (!plan.unresolved && plan.tables.length === 0) {
      return () => {}
    }

    const startedAt = Date.now()
    const executionId = mode === 'detailed' ? randomUUID() : ''

    let traceId: string | null = null

    try {
      traceId = activeTraceId(otel)
    } catch (error) {
      track(report(error))
    }

    return observation => {
      if (closing) {
        return
      }

      try {
        const now = Date.now()

        const scopes = observation.rows
          ? resolveScopes(plan, observation.rows, mode === 'standard' ? rangeLimit : Infinity)
          : []

        if (mode === 'detailed') {
          const counts = observationCounts(observation)
          const tables = observation.rows || observation.first || observation.status === 'failed'
            ? plan.tables.map(({ table }, index) => {
              const scope = scopes[index]

              return tableSummary(table, {
                ...counts,
                unresolvedObservations: counts.unresolvedObservations + (scope?.unresolved ? 1 : 0),
                ids: scope?.ids ?? new Set(),
                returnedBounds: scope?.returnedBounds ?? null,
                predicate: scope?.predicate ?? null,
                overflow: false,
              })
            })
            : []

          dispatch({
            at: timestamp(now),
            ...(tables.length > 0 && { tables }),
            ...(plan.unresolved && observation.first && { opaque: 1 }),
            ...(plan.unresolved && observation.status === 'failed' && { fails: 1 }),
            run: {
              id: executionId,
              ...(now !== startedAt && { start: timestamp(startedAt) }),
              ...(traceId !== null && { trace: traceId }),
              ...(observation.status !== 'success' && { status: observation.status }),
            },
          })
        } else {
          accumulate(now, plan, observation, scopes)
        }
      } catch (error) {
        track(report(error))
      }
    }
  }

  return {
    wrapDialect (dialect) {
      return wrapDialect(dialect, observeFor({
        // MySQL can compare BIGINT parameters through a floating-point conversion.
        exactIntegerComparisons: !(dialect instanceof MysqlDialect),
        nativeUuidComparisons: dialect instanceof PostgresDialect || dialect instanceof PGliteDialect,
      }))
    },
    close () {
      if (!closing) {
        // Defer to establish the close promise before invoking callbacks.
        closing = Promise.resolve().then(() => {
          flush(Date.now())

          return Promise.all(pending)
        }).then(() => {})
      }

      return closing
    },
  }
}
