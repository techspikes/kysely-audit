import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import {
  CompiledQuery, DummyDriver, Kysely, MysqlDialect, SelectQueryNode,
  type DatabaseConnection, type Dialect, type QueryResult, SelectionNode, SqliteDialect, TableNode, createQueryId,
} from 'kysely'
import { createAudit, type AuditEvent, type AuditOptions } from '../src/index.ts'

type Item = { id: number | bigint | string; label: string; value: string; deleted: boolean }
type Database = { items: Item; 'app.items': Item }
type Configuration = Partial<AuditOptions> & {
  dialect?: Dialect
  execute?: (query: CompiledQuery) => Promise<QueryResult<unknown>>
  stream?: (query: CompiledQuery) => AsyncIterableIterator<QueryResult<unknown>>
}

const configured: AuditOptions['tables'] = [{ table: 'items', key: 'id', keyType: 'integer' }]
const runNode = promisify(execFile)

function database (t: TestContext, configuration: Configuration) {
  const events: AuditEvent[] = []
  const dialect = configuration.dialect ?? new SqliteDialect({ database: () => { throw new Error('Unexpected SQLite open') } })
  const audit = createAudit({
    mode: Object.hasOwn(configuration, 'mode') ? configuration.mode : 'detailed',
    tables: configuration.tables ?? configured,
    writeAuditEvent: configuration.writeAuditEvent ?? (event => { events.push(event) }),
    onAuditError: configuration.onAuditError,
  })
  const connection = {
    executeQuery: configuration.execute ?? (async () => ({ rows: [{ id: 7 }] })),
    streamQuery: configuration.stream ?? async function * () {},
  }
  class Driver extends DummyDriver {
    async acquireConnection () { return connection as DatabaseConnection }
    async releaseConnection (value?: DatabaseConnection) { assert.equal(value, connection) }
  }
  dialect.createDriver = () => new Driver()
  const db = new Kysely<Database>({ dialect: audit.wrapDialect(dialect) })
  t.after(async () => {
    await db.destroy()
    await audit.close()
  })

  return { db, events, audit }
}

test('MySQL and SQLite compile different SQL and use the same audit rules', async t => {
  for (const [name, dialect, quoted] of [
    ['MySQL', new MysqlDialect({ pool: () => { throw new Error('Unexpected MySQL open') } }), '`items`'],
    ['SQLite', new SqliteDialect({ database: () => { throw new Error('Unexpected SQLite open') } }), '"items"'],
  ] as const) {
    await t.test(name, async t => {
      const captured: { compiled?: CompiledQuery } = {}
      const { db, events } = database(t, {
        dialect,
        execute: async query => {
          captured.compiled = query

          return { rows: [{ label: 'hidden' }] }
        },
      })
      const result = await db.selectFrom('items').select('label').where('id', '>=', 7).execute()
      assert.deepEqual(result, [{ label: 'hidden' }])
      assert.ok(captured.compiled)
      assert.ok(captured.compiled.sql.includes(quoted))
      assert.deepEqual(events[0].tables![0].pred, { kind: 'spans', spans: [['7', null]] })
      assert.doesNotMatch(JSON.stringify(events), /hidden|select/)

      if (name === 'MySQL') {
        await db.selectFrom('items').select('label').where('id', '=', 9007199254740993n).execute()
        assert.deepEqual(events[1].tables![0].miss, 1)
      }
    })
  }
})

test('streams record received chunks before early close or failure', async t => {
  const failure = new Error('sensitive driver message')
  let opened = 0
  let closed = 0
  const { db, events } = database(t, {
    stream: async function * () {
      const attempt = ++opened
      try {
        yield { rows: [{ id: 7 }] }

        if (attempt === 2) { throw failure }

        yield { rows: [{ id: 8 }] }
      } finally {
        closed++
      }
    },
  })
  const select = () => db.selectFrom('items').select('id')

  // eslint-disable-next-line no-unreachable-loop -- Exercise iterator cleanup when the consumer breaks.
  for await (const row of select().stream(1)) {
    assert.deepEqual(row, { id: 7 })
    break
  }

  await assert.rejects(async () => {
    for await (const row of select().stream(1)) { assert.deepEqual(row, { id: 7 }) }
  }, error => error === failure)

  for await (const row of select().stream(1)) { assert.ok(row.id) }

  assert.equal(closed, 3)
  assert.deepEqual(events.map(event => event.run!.status ?? 'success'), ['chunk', 'closed', 'chunk', 'failed', 'chunk', 'chunk', 'success'])
  assert.equal(events[0].run!.id, events[1].run!.id)
  assert.equal(events[2].run!.id, events[3].run!.id)
  assert.notEqual(events[0].run!.id, events[2].run!.id)
  assert.deepEqual(events[0].tables![0].ids, ['7'])
  assert.deepEqual(events[2].tables![0].ids, ['7'])
  assert.deepEqual(events[5].tables![0].ids, ['8'])
  assert.equal(events[6].tables, undefined)
  assert.equal(events[6].run!.status, undefined)
  assert.equal('rows' in events[6] ? events[6].rows : undefined, undefined)
  assert.doesNotMatch(JSON.stringify(events), /sensitive driver message/)
})

test('standard mode uses UTC quarter-hour windows and flushes a partial window on close', async t => {
  const start = Date.UTC(2026, 0, 1, 12, 14, 59, 900)
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start })
  const { db, events, audit } = database(t, { mode: 'standard' })
  const select = () => db.selectFrom('items')
  await select().select('id').execute()
  await select().select('value').where('id', 'in', [1, 5]).execute()
  await select().select('value').where('id', '!=', 5).execute()
  assert.equal(events.length, 0)

  t.mock.timers.tick(100)
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], {
    at: '2026-01-01T12:00:00.000Z',
    tables: [{
      table: 'items',
      ids: ['7'],
      pred: { kind: 'spans', spans: [['1', '5']] },
      rows: 3,
      miss: 1,
    }],
  })

  t.mock.timers.tick(15 * 60 * 1000)
  assert.equal(events.length, 1)
  await select().select('value').execute()
  await db.executeQuery(CompiledQuery.raw('select hidden()'))
  t.mock.timers.tick(50)
  await Promise.all([audit.close(), audit.close()])
  assert.equal(events.length, 2)
  assert.equal(events[1].at, '2026-01-01T12:30:00.000Z')
  assert.equal('end' in events[1] ? events[1].end : undefined, '2026-01-01T12:30:00.050Z')
  assert.equal(events[1].opaque, 1)
  assert.deepEqual(events[1].tables![0].pred, { kind: 'all' })
})

test('compact table identifiers distinguish a dot in a name from a schema separator', async t => {
  const tables: AuditOptions['tables'] = [
    { table: 'app.items', key: 'id', keyType: 'integer' },
    { schema: 'app', table: 'items', key: 'id', keyType: 'integer' },
  ]
  const { db, events } = database(t, { tables })
  const query = SelectQueryNode.cloneWithSelections(
    SelectQueryNode.createFrom([TableNode.create('app.items')]),
    [SelectionNode.createSelectAll()]
  )
  await db.executeQuery(db.getExecutor().compileQuery(query, createQueryId()))
  await db.selectFrom('app.items').select('id').execute()

  assert.deepEqual(events.map(event => event.tables![0].table), ['"app.items"', 'app.items'])
})

test('UUID range inference requires a dialect with native UUID ordering', async t => {
  assert.throws(() => createAudit({
    // @ts-expect-error Exercise the runtime guard for incompatible UUID options.
    tables: [{ table: 'items', key: 'id', keyType: 'native-uuid', uuidFormat: 'hex' }],
  }), /uuidFormat requires keyType uuid/)

  const { db, events } = database(t, {
    tables: [{ table: 'items', key: 'id', keyType: 'native-uuid' }],
  })
  await db.selectFrom('items').select('label').where('id', '>', '019535d9-3df7-79fb-b466-fa907fa17f90').execute()
  assert.deepEqual(events[0].tables![0].miss, 1)
})

test('detailed logs omit timestamps only when the observation time equals the start time', async t => {
  const start = Date.UTC(2026, 0, 1, 12, 1)
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const { db, events } = database(t, {
    execute: async query => {
      const delay = query.parameters[0]
      assert.ok(typeof delay === 'number')
      t.mock.timers.tick(delay)

      return { rows: [] }
    },
  })

  for (const delay of [0, 5]) {
    await db.selectFrom('items').select('id').where('id', '=', delay).execute()
  }

  assert.equal(events[0].at, '2026-01-01T12:01:00.000Z')
  assert.equal(Object.hasOwn(events[0].run!, 'start'), false)
  assert.equal(events[0].tables![0].rows, undefined)
  assert.equal(events[1].at, '2026-01-01T12:01:00.005Z')
})

test('standard mode marks overflow while retaining evidenced IDs', async t => {
  const rows = Array.from({ length: 10_002 }, (_, id) => ({ id }))
  const { db, events, audit } = database(t, { mode: 'standard', execute: async () => ({ rows }) })
  await db.selectFrom('items').select('id').execute()
  await db.selectFrom('items').select('value').where('id', '=', 10_001).execute()
  await audit.close()
  const summary = events[0].tables![0]
  assert.equal(summary.ids!.length, 10_000)
  assert.equal(summary.ids!.at(-1), '9999')
  assert.equal(summary.rows, 20_004)
  assert.equal(summary.overflow, true)
  assert.equal(summary.miss, 2)
})

test('standard ShortUUID bounds cover observed IDs beyond the ID list limit', async t => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const first = '1'.repeat(22)
  const last = 'z'.repeat(22)
  const rows = Array.from({ length: 10_000 }, (_, index) => {
    const high = alphabet[Math.floor(index / (58 * 58))]
    const middle = alphabet[Math.floor(index / 58) % 58]
    const low = alphabet[index % 58]

    return { id: '1'.repeat(19) + high + middle + low }
  })
  rows.push({ id: last })
  const { db, events, audit } = database(t, {
    mode: 'standard',
    tables: [{ table: 'items', key: 'id', keyType: 'uuid', uuidFormat: 'short' }],
    execute: async () => ({ rows }),
  })

  await db.selectFrom('items').select('id').where('deleted', '=', false).execute()
  await audit.close()

  const summary = events[0].tables![0]
  assert.equal(summary.ids!.length, 10_000)
  assert.equal(summary.ids!.includes(last), false)
  assert.equal(summary.overflow, true)
  assert.deepEqual(summary.bounds, [first, last])
})

test('standard bounds preserve an unbounded end and expand to all for two unbounded ends', async t => {
  const start = Date.UTC(2026, 0, 1, 12, 14, 59, 900)
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start })
  const { db, events, audit } = database(t, { mode: 'standard' })
  const select = () => db.selectFrom('items').select('value')

  await select().where('id', '>=', 12).execute()
  await select().where('id', '=', -2).execute()
  t.mock.timers.tick(100)
  assert.deepEqual(events[0].tables![0].pred, { kind: 'spans', spans: [['-2', null]] })

  await select().where('id', '>=', 12).execute()
  await select().where('id', '<', -2).execute()
  await audit.close()
  assert.deepEqual(events[1].tables![0].pred, { kind: 'all' })
})

test('standard summaries distinguish an empty interval from a single ID', async t => {
  const start = Date.UTC(2026, 0, 1, 12, 14, 59, 900)
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start })
  const { db, events, audit } = database(t, { mode: 'standard', execute: async () => ({ rows: [] }) })
  const select = () => db.selectFrom('items').select('value')

  await select().where('id', '<', 2).where('id', '>=', 2).execute()
  t.mock.timers.tick(100)
  assert.deepEqual(events[0].tables![0].pred, { kind: 'empty' })

  await select().where('id', '=', 2).execute()
  await audit.close()
  assert.deepEqual(events[1].tables![0].pred, { kind: 'spans', spans: [['2']] })
})

test('omitting the mode produces the same summary as explicit standard mode', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 0, 1, 12, 1) })
  const defaultMode = database(t, { mode: undefined })
  const explicitMode = database(t, { mode: 'standard' })

  for (const { db, audit, events } of [defaultMode, explicitMode]) {
    assert.deepEqual(await db.selectFrom('items').select('id').execute(), [{ id: 7 }])
    assert.deepEqual(events, [])
    await audit.close()
  }

  assert.equal(defaultMode.events[0].run, undefined)
  assert.deepEqual(defaultMode.events, explicitMode.events)
})

test('default callbacks write JSON and can be overridden independently', async () => {
  const { stdout, stderr } = await runNode(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { closeSync } from 'node:fs'
    import { DummyDriver, Kysely, SqliteDialect } from 'kysely'
    import { createAudit } from './src/index.ts'

    async function observe(callbacks) {
      const tables = [{ table: 'items', key: 'id', keyType: 'integer' }]
      const audit = createAudit({ tables, ...callbacks })
      const dialect = new SqliteDialect({ database: () => { throw new Error('Unexpected SQLite open') } })
      const driver = new DummyDriver()
      driver.acquireConnection = async () => ({
        executeQuery: async () => ({ rows: [{ id: 7 }] }),
      })
      dialect.createDriver = () => driver
      const db = new Kysely({ dialect: audit.wrapDialect(dialect) })
      try {
        assert.deepEqual(await db.selectFrom('items').select('id').execute(), [{ id: 7 }])
      } finally {
        await db.destroy()
        await audit.close()
      }
    }

    await observe({})
    await observe({ writeAuditEvent() { throw new Error('private sink details') } })

    closeSync(1)
    const reported = []
    await observe({
      async onAuditError(error) {
        await new Promise(resolve => setImmediate(resolve))
        reported.push(error.code)
      },
    })
    assert.deepEqual(reported, ['EBADF'])
  `], { cwd: new URL('..', import.meta.url) })

  const events = stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events.length, 1)
  assert.equal(events[0].run, undefined)
  assert.deepEqual(events[0].tables![0].ids, ['7'])
  assert.deepEqual(JSON.parse(stderr), { level: 'error', message: 'Audit logging failed' })
})

test('writer and error-handler failures preserve result and driver error', async t => {
  const driverError = new Error('driver')
  const syncWriteError = new Error('sync write')
  const asyncWriteError = new Error('async write')
  const handled: unknown[] = []
  const { db, audit } = database(t, {
    execute: async query => {
      if (query.parameters.includes(1)) { throw driverError }

      return { rows: [{ id: 7 }] }
    },
    writeAuditEvent: event => {
      if (event.run!.status === 'failed') { throw syncWriteError }

      return Promise.reject(asyncWriteError)
    },
    onAuditError: async error => {
      handled.push(error)

      throw new Error('error handler')
    },
  })
  assert.deepEqual(await db.selectFrom('items').select('id').execute(), [{ id: 7 }])
  await assert.rejects(db.selectFrom('items').select('id').where('id', '=', 1).execute(), error => error === driverError)
  await audit.close()
  assert.deepEqual(new Set(handled), new Set([syncWriteError, asyncWriteError]))
})

test('concurrent requests keep their OpenTelemetry trace IDs', async t => {
  type Context = object
  type ContextManager = {
    active: () => Context
    with: <Args extends unknown[], Result>(ctx: Context, callback: (...args: Args) => Result, self: unknown, ...args: Args) => Result
    bind: <Args extends unknown[], Result>(ctx: Context, callback: (...args: Args) => Result) => (...args: Args) => Result
    enable: () => ContextManager
    disable: () => ContextManager
  }
  type OtelApi = {
    context: {
      setGlobalContextManager: (manager: ContextManager) => boolean
      disable: () => void
      with: <Result>(ctx: Context, callback: () => Result) => Result
    }
    trace: {
      setSpanContext: (ctx: Context, span: { traceId: string; spanId: string; traceFlags: number }) => Context
    }
    ROOT_CONTEXT: Context
  }
  const moduleName = '@opentelemetry/api'
  let otel: OtelApi | undefined = undefined
  try {
    otel = await import(moduleName) as OtelApi
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') { throw error }

    t.skip('Install the optional @opentelemetry/api peer to run this integration test')

    return
  }

  const { context, trace, ROOT_CONTEXT } = otel
  const local = new AsyncLocalStorage<Context>()
  const manager: ContextManager = {
    active: () => local.getStore() ?? ROOT_CONTEXT,
    with: (ctx, callback, self, ...args) => local.run(ctx, () => callback.apply(self, args)),
    bind: (ctx, callback) => (...args) => local.run(ctx, () => callback(...args)),
    enable () { return this },
    disable () {
      local.disable()

      return this
    },
  }
  assert.ok(context.setGlobalContextManager(manager))
  t.after(() => context.disable())

  const firstCanReturn = Promise.withResolvers<void>()
  const { db, events } = database(t, {
    execute: async query => {
      const id = query.parameters[0]

      if (id === 1) { await firstCanReturn.promise }

      return { rows: [{ id }] }
    },
  })
  const traceIds = ['1'.repeat(32), '2'.repeat(32)]
  const query = (index: number) => {
    const ctx = trace.setSpanContext(ROOT_CONTEXT, { traceId: traceIds[index], spanId: 'f'.repeat(16), traceFlags: 0 })

    return context.with(ctx, () => db.selectFrom('items').select('id').where('id', '=', index + 1).execute())
  }

  const first = query(0)
  try {
    await query(1)
  } finally {
    firstCanReturn.resolve()
    await first
  }

  assert.deepEqual(events.map(event => [event.tables![0].ids![0], event.run!.trace]), [
    ['2', traceIds[1]], ['1', traceIds[0]],
  ])
})

test('both modes emit the same compact table fields for a single SELECT', async t => {
  const standard = database(t, { mode: 'standard' })
  const detailed = database(t, { mode: 'detailed' })

  for (const { db, audit } of [standard, detailed]) {
    await db.selectFrom('items').select('id').execute()
    await audit.close()
  }

  const [summary] = standard.events
  const [execution] = detailed.events
  assert.deepEqual(summary.tables, [{ table: 'items', ids: ['7'], rows: 1 }])
  assert.deepEqual(execution.tables, summary.tables)
  assert.deepEqual(Object.keys(execution).sort(), ['at', 'run', 'tables'])
  assert.equal(Object.hasOwn(summary, 'mode'), false)
  assert.equal(Object.hasOwn(summary, 'run'), false)
  assert.ok(execution.run!.id)
  assert.equal(Object.hasOwn(execution.run!, 'status'), false)
})
