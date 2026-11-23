# kysely-audit

[![AI Generated | Codex](https://img.shields.io/badge/AI%20Generated-Codex-blue?style=flat)](https://shields.io/)
[![Coverage](https://codecov.io/gh/techspikes/kysely-audit/branch/main/graph/badge.svg)](https://app.codecov.io/gh/techspikes/kysely-audit)
[![neostandard javascript style](https://img.shields.io/badge/code_style-neostandard-brightgreen?style=flat)](https://github.com/neostandard/neostandard)
[![npm version](https://img.shields.io/npm/v/%40techspikes/kysely-audit?style=flat)](https://www.npmjs.com/package/@techspikes/kysely-audit)

> [!WARNING]
> This package is experimental. Its API and audit log format may change.

kysely-audit helps application operations teams quickly assess which records may have been exposed in a data breach and make a preliminary disclosure. Incident investigation teams and security specialists should use other tools alongside kysely-audit to verify which records were actually exposed and prepare the final report.

Agile teams can also use kysely-audit as a quality gate to catch and fix unauditable queries before release, making auditability a team habit and becoming **Auditable by Design**.

## Compatibility

| Plugin version | Node.js version | Kysely version |
| -------------- | --------------- | -------------- |
| `0.1.0` | `24.x`, `26.x` | `>=0.29.8 <0.30.0` |

Works with common Kysely dialects. Audit logging is integration-tested with PGlite.

## Benchmark

These sample results compare a primary-key lookup in PGlite with and without auditing. Use them as a reference when choosing an audit mode. Results vary by workload and runtime.

| Configuration | Queries/s | p50 (ms) | p99 (ms) | vs. no audit | Audit log (bytes) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unwrapped | 4,663 | 0.166 | 0.354 | 100.0% | 0 |
| Standard | 4,202 | 0.190 | 0.478 | 90.1% | 121 |
| Detailed | 3,980 | 0.207 | 0.483 | 85.3% | 229,315 |

Values are arithmetic means across three benchmark runs on Node.js v24.22.3.
Audit log size includes UTF-8 JSON lines for all 1,600 queries per run (100
warmup and 1,500 timed), including the standard mode's final flush. Standard
mode took 0.257 ms on average to close and flush.

Run `npm run benchmark` to measure the same workload in your environment.

## Setup

Wrap the `Dialect` when creating your Kysely instance. This example uses an in-memory PGlite database.

```sh
npm install @techspikes/kysely-audit 'kysely@>=0.29.8 <0.30.0' @electric-sql/pglite
```

```ts
import { PGlite } from '@electric-sql/pglite'
import { Kysely, PGliteDialect } from 'kysely'
import { createAudit } from '@techspikes/kysely-audit'

interface Database {
  users: { id: number; name: string }
}

const pglite = new PGlite()

const audit = createAudit({
  tables: [
    { table: 'users', key: 'id', keyType: 'integer' },
  ],
})

const db = new Kysely<Database>({
  dialect: audit.wrapDialect(new PGliteDialect({ pglite })),
})

try {
  await pglite.exec(`
    create table users (id integer primary key, name text not null)
  `)

  await db.insertInto('users')
    .values({ id: 1, name: 'Ada' })
    .execute()

  await db.selectFrom('users')
    .select(['id', 'name'])
    .where('id', '=', 1)
    .execute()
} finally {
  // Finish active queries and streams before shutting down.
  try {
    await db.destroy()
  } finally {
    await audit.close()
  }
}
```

Choose one unique, non-null key column per table. Use the table, schema, and column names that appear in the compiled Kysely queries. If a table needs a schema qualifier, use it in both the audit configuration and the queries. When a query uses an unqualified name that matches a schema-qualified audit entry, the audit records the range for that candidate as unresolved. Set `exactStringEquality: true` to infer string keys from `WHERE` predicates only when the database collation uses the same string equality as JavaScript.

Use `keyType: 'native-uuid'` for PostgreSQL and PGlite native `uuid` columns. Use `keyType: 'uuid'` for UUIDs stored as text, including UUIDv7. Text UUID keys accept the following formats.

| `uuidFormat` | Stored format |
| --- | --- |
| `standard` | Lowercase 36-character UUID with hyphens. This is the default for `uuid` |
| `hex` | Lowercase UUID in 32 hexadecimal characters |
| `short` | Fixed-width 22-character Base58 ShortUUID |

Native UUID predicate inference follows the database's UUID ordering. Predicate inference for stored `standard` or `hex` text assumes bytewise comparison, such as PostgreSQL's `COLLATE "C"` or SQLite's `COLLATE BINARY`. Use the stored format for text query bounds. A noncanonical text literal may contribute an unresolved observation. For `short`, the audit calculates `bounds` from returned IDs using its own ASCII order. This calculation works with any database collation.

```ts
const tables = [
  { table: 'events', key: 'id', keyType: 'uuid', uuidFormat: 'short' },
  { table: 'orders', key: 'id', keyType: 'uuid', uuidFormat: 'hex' },
  { table: 'users', key: 'id', keyType: 'uuid' },
  { table: 'accounts', key: 'id', keyType: 'native-uuid' },
] as const
```

Omit `mode` to use `standard`, which reduces log volume by aggregating observations in 15-minute windows. Set `mode: 'detailed'` to record individual executions and stream chunks. The named modes make the output behavior explicit in configuration and control whether events include per-execution metadata.

### Customize structured logging with Pino

By default, audit events are written synchronously as newline-delimited JSON to stdout. Audit failures produce a fixed JSON diagnostic on stderr. You can override either callback independently. Both callbacks accept synchronous or asynchronous implementations.

Install Pino in your application with `npm install pino` and pass structured fields to the logger.

```ts
import pino from 'pino'
import { createAudit } from '@techspikes/kysely-audit'

const logger = pino({ name: 'database-audit' })

const audit = createAudit({
  mode: 'detailed',
  tables: [
    { table: 'users', key: 'id', keyType: 'integer' },
  ],
  writeAuditEvent(event) {
    logger.info({ audit: event }, 'Database audit')
  },
  onAuditError() {
    logger.error({ auditFailure: true }, 'Audit logging failed')
  },
})
```

### Discover primary keys automatically

Pass the names of the tables to monitor to `discoverAuditTables()`. It reads each single-column primary key and its SQL type from the database catalog and returns configuration for `createAudit()`. Table names are checked against `Kysely<Database>` and may be schema-qualified, as in `'billing.orders'`. If you use `CamelCasePlugin` or `withSchema()`, use the same settings for discovery and for the monitored queries.

```ts
import { createAudit, discoverAuditTables } from '@techspikes/kysely-audit'

const audit = createAudit({
  tables: await discoverAuditTables(catalogDb, ['users', 'billing.orders'])
})

const db = new Kysely<Database>({
  dialect: audit.wrapDialect(appDialect),
})
```

Run discovery after creating the schema and before enabling auditing. The catalog connection resolves unqualified names using its own search path or default database. Use the same name resolution settings as the application. The caller owns the catalog connection and is responsible for closing it.

Discovery supports PostgreSQL, PGlite, MySQL, and SQLite 3.37 or later. It identifies native PostgreSQL and PGlite UUID keys as `native-uuid`. Initialization fails if a table has no primary key or if its primary key is composite, nullable, or an unsupported type. On SQLite, discovery supports integer keys backed by an `INTEGER PRIMARY KEY` rowid alias or an integer column in a `STRICT` table. To infer string keys from equality predicates, explicitly set `exactStringEquality` on the generated configuration.

Discovery treats text primary keys as UUIDs in `standard` (hyphenated) format by default. Pass `{ uuidFormat: 'short' }` or `{ uuidFormat: 'hex' }` as the third argument to use a different UUID format for all text keys discovered in that call. For ordinary text keys, set `keyType: 'string'` on the table configuration passed to `createAudit()`. Integer and native UUID keys are classified by their SQL types.

For `events` and `orders` with ShortUUIDs stored as text, specify `uuidFormat: 'short'`.

```ts
const tables = await discoverAuditTables(catalogDb, ['events', 'orders'], {
  uuidFormat: 'short',
})

const audit = createAudit({ tables })
```

## Graceful shutdown

On shutdown, stop accepting new work and wait for active queries and streams to
finish. Then call `await audit.close()` before exiting. In `standard` mode, this
flushes the final partial window immediately, even if fewer than 15 minutes have
elapsed, and waits for pending audit callbacks. If a custom logger buffers
writes, flush it after `audit.close()` completes. A forced termination can lose
observations still held in memory.

```ts
import { promisify } from 'node:util'
import closeWithGrace from 'close-with-grace'
import express from 'express'

// Create db and audit here as shown in the setup example.

const app = express()
const server = app.listen(3000)

closeWithGrace({ delay: 10_000 }, async () => {
  await promisify(server.close.bind(server))()

  try {
    await db.destroy()
  } finally {
    await audit.close()
  }
})
```

## Reading audit logs

### Standard logs

Standard mode groups observations into 15-minute UTC windows. This example
shows a window in which one query returned user ID `1`. The JSON examples
are formatted for readability. The built-in writer emits one line per event.

```json
{
  "at": "2026-11-23T10:30:00.000Z",
  "tables": [
    { "table": "users", "ids": ["1"], "rows": 1 }
  ]
}
```

| Event field | Meaning |
| --- | --- |
| `at` | Start of the UTC window. |
| `end` | End of a partial window flushed by `close()`. If omitted, the window ends 15 minutes after `at`. |
| `tables` | One entry per monitored table observed in the window. |
| `opaque` | Number of executions for which the audit could not fully identify the tables. |
| `fails` | Number of failed opaque executions. |

| Table field | Meaning |
| --- | --- |
| `table` | The table name, for example `users` or `billing.users`. Identifiers containing a dot or double quote are double-quoted, with internal quotes doubled. |
| `ids` | Distinct IDs observed in returned rows. Integer keys use decimal strings. |
| `bounds` | The smallest and largest returned ShortUUID in ASCII order, including IDs beyond the retained list limit. |
| `pred` | Candidate IDs inferred from query conditions when a returned key cannot be observed. |
| `rows` | Returned row count. For a join, each monitored table gets the count of result rows. Use distinct aliases for selected key columns. Unmatched outer-join keys are omitted from `ids`. |
| `miss` | Observations for which the audit could not resolve the table's scope, including observations that exceed the retention limit. |
| `fails` | Failed executions involving this table. |
| `overflow` | The limit of 10,000 retained IDs and predicate entries for this table and window was exceeded. |

The `pred` field describes what the query conditions imply about candidate IDs.

| `pred.kind` | Meaning |
| --- | --- |
| `ids` | `pred.ids` lists the inferred candidates. |
| `spans` | `pred.spans` contains inclusive intervals. Standard mode combines them into one covering interval, which can include IDs between separate predicates. |
| `empty` | The predicate has no candidates. |
| `all` | Every ID is a candidate. |

A span `[id]` represents a single ID, and a `null` endpoint is unbounded.
Missing lists are empty, missing counters are zero, and missing `overflow`
means false. Omitted `pred` and `bounds` have no value to report. Check
`miss` for unresolved scope.

Each process aggregates independently.

### Detailed logs

Set `mode: 'detailed'` to log each execution and stream observation. The table
fields above keep the same meanings for that observation, and `pred.spans`
preserves separate intervals. Here, `at` is the observation time. The presence
of `run` identifies a detailed log.

```json
{
  "at": "2026-11-23T10:31:02.004Z",
  "tables": [
    { "table": "users", "ids": ["1"], "rows": 1 }
  ],
  "run": {
    "id": "e38ed80e-c220-4893-8add-83d7db8d2503",
    "start": "2026-11-23T10:31:02.000Z"
  }
}
```

| Additional field | Meaning |
| --- | --- |
| `run.id` | Execution ID. Stream chunks and their terminal event share this ID. |
| `run.start` | Query start time. If omitted, it equals `at`. |
| `run.trace` | OpenTelemetry trace ID when a valid span is active. Install `@opentelemetry/api` and enable an OpenTelemetry context manager to capture it. |
| `run.status` | `chunk` for a stream chunk, `closed` for early stream termination, or `failed` for a driver error. If omitted, the observation succeeded. |

For an opaque stream, the first observation carries `opaque` and the terminal
observation carries `fails` if the stream failed.

## Audit coverage

- The audit observes queries through the wrapped Kysely dialect. Direct database connections, reads inside views or stored functions, and the physical rows scanned by the database engine are outside its scope.
- The audit also observes statements that read as part of a write, such as statements with `RETURNING`. For those statements it can identify monitored tables and count the observation under `miss`.
- Raw SQL is treated as opaque. Queries whose tables cannot be identified appear under `opaque`. For complex queries, the audit can still report known monitored tables with a `miss` count. With MySQL, bounds outside JavaScript's safe integer range can yield an unresolved observation because of conversion precision.
- Audit events include monitored keys and range endpoints. SQL text, other parameter values, full rows, and database error messages are excluded. Configure access and retention for the log destination because it contains monitored keys. Log delivery failures are reported to `onAuditError` while the caller receives the original query result or error.
