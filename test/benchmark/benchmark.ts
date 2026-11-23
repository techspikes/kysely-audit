import assert from 'node:assert/strict'
import { closeSync, openSync, writeFileSync } from 'node:fs'
import { arch, cpus, devNull, release, type } from 'node:os'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { Kysely, PGliteDialect } from 'kysely'
import { createAudit, type Audit, type AuditEvent } from '../../src/index.ts'

const modes = ['unwrapped', 'standard', 'detailed'] as const
type Item = { id: number; label: string }
type Database = { items: Item }
type Query = { executeTakeFirstOrThrow: () => Promise<Item> }
type Fixture = {
  mode: typeof modes[number]
  pglite: PGlite
  audit: Audit | null
  db: Kysely<Database> | null
  query: Query | null
  logBytes: number
  samples: Awaited<ReturnType<typeof measure>>[]
}
const warmupQueries = 100
const queriesPerRound = 500
const rounds = 3
const expected = { id: 42, label: 'item-42' }

async function closeFixture ({ audit, db, pglite }: Fixture) {
  try {
    await audit?.close()
  } finally {
    try {
      await db?.destroy()
    } finally {
      if (!pglite.closed) {
        await pglite.close()
      }
    }
  }
}

function percentile (sorted: readonly number[], fraction: number) {
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}

function median (values: readonly number[]) {
  return percentile(values.toSorted((a, b) => a - b), 0.5)
}

async function measure (query: Query) {
  const latencies = []
  const start = performance.now()

  for (let index = 0; index < queriesPerRound; index++) {
    const queryStart = performance.now()
    const item = await query.executeTakeFirstOrThrow()
    latencies.push(performance.now() - queryStart)
    assert.deepEqual(item, expected)
  }

  const elapsed = performance.now() - start
  latencies.sort((a, b) => a - b)

  return {
    queriesPerSecond: queriesPerRound * 1000 / elapsed,
    p50Ms: percentile(latencies, 0.5),
    p99Ms: percentile(latencies, 0.99),
  }
}

test('direct Kysely primary-key audit benchmark', async t => {
  const fixtures: Fixture[] = []
  const auditErrors: unknown[] = []
  const sink = openSync(devNull, 'w')

  const onAuditError = (error: unknown) => {
    auditErrors.push(error)
  }

  t.after(async () => {
    try {
      const results = await Promise.allSettled(fixtures.map(closeFixture))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])

      if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to close benchmark fixtures')
      }
    } finally {
      closeSync(sink)
    }
  })

  for (const mode of modes) {
    const pglite = new PGlite()
    const fixture: Fixture = { mode, pglite, audit: null, db: null, query: null, logBytes: 0, samples: [] }
    fixtures.push(fixture)

    const dialect = new PGliteDialect({ pglite })

    if (mode !== 'unwrapped') {
      fixture.audit = createAudit({
        ...(mode === 'detailed' && { mode }),
        tables: [{ table: 'items', key: 'id', keyType: 'integer' }],
        writeAuditEvent (event: AuditEvent) {
          const line = Buffer.from(JSON.stringify(event) + '\n', 'utf8')
          writeFileSync(sink, line)
          fixture.logBytes += line.length
        },
        onAuditError,
      })
    }

    fixture.db = new Kysely<Database>({ dialect: fixture.audit?.wrapDialect(dialect) ?? dialect })
    fixture.query = fixture.db.selectFrom('items').select(['id', 'label']).where('id', '=', expected.id)

    await pglite.exec(`
      create table items (id integer primary key, label text not null);
      insert into items select id, 'item-' || id from generate_series(1, 1000) as id;
    `)
  }

  for (const { query } of fixtures) {
    assert.ok(query)

    for (let index = 0; index < warmupQueries; index++) {
      assert.deepEqual(await query.executeTakeFirstOrThrow(), expected)
    }
  }

  for (let round = 0; round < rounds; round++) {
    const offset = round % fixtures.length
    const order = [...fixtures.slice(offset), ...fixtures.slice(0, offset)]

    for (const fixture of order) {
      assert.ok(fixture.query)
      fixture.samples.push(await measure(fixture.query))
    }
  }

  const standard = fixtures.find(fixture => fixture.mode === 'standard')
  const flushStart = performance.now()
  assert.ok(standard?.audit)
  await standard.audit.close()
  const flushMs = performance.now() - flushStart
  assert.deepEqual(auditErrors, [])

  const baseline = median(fixtures[0].samples.map(sample => sample.queriesPerSecond))
  t.diagnostic(`Node.js ${process.version}, ${type()} ${release()} ${arch()}, ${cpus()[0]?.model ?? 'unknown CPU'}`)
  t.diagnostic(`${warmupQueries} warmup queries per configuration, ${rounds} rounds of ${queriesPerRound} measured queries`)
  t.diagnostic(`Audit log size includes all ${warmupQueries + rounds * queriesPerRound} queries and the standard mode's final flush.`)
  t.diagnostic('| Configuration | Queries/s | p50 (ms) | p99 (ms) | Unwrapped throughput | Audit log (bytes) |')
  t.diagnostic('| --- | ---: | ---: | ---: | ---: | ---: |')

  for (const { mode, samples, logBytes } of fixtures) {
    const rate = median(samples.map(sample => sample.queriesPerSecond))
    const p50 = median(samples.map(sample => sample.p50Ms))
    const p99 = median(samples.map(sample => sample.p99Ms))
    const relative = rate / baseline * 100
    t.diagnostic(`| ${mode} | ${rate.toFixed(0)} | ${p50.toFixed(3)} | ${p99.toFixed(3)} | ${relative.toFixed(1)}% | ${logBytes} |`)
  }

  t.diagnostic(`Standard mode close and flush: ${flushMs.toFixed(3)} ms`)
})
