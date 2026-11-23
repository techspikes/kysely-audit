import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { type DatabaseConnection, type SqliteStatement, CamelCasePlugin, DummyDriver, Kysely, MysqlDialect, PGliteDialect, SqliteDialect } from 'kysely'
import { createAudit, discoverAuditTables, type AuditEvent } from '../src/index.ts'

test('PGlite discovers actual primary keys and applies them to the audit', async t => {
  const pglite = new PGlite()
  t.after(() => pglite.close())
  await pglite.exec(`
    create table user_accounts (id integer not null, user_number bigint, primary key (user_number) include (id));
    create schema billing;
    create table public.orders (id bigint primary key);
    create table billing.orders (order_uuid uuid primary key);
    create table "odd""name" (id text primary key);
    create table no_pk (id integer unique not null);
    create table pairs (a integer, b integer, primary key (a, b));
    create table amounts (id numeric primary key);
    insert into user_accounts values (7, 9007199254740993);
    insert into billing.orders values ('00000000-0000-0000-0000-000000000001');
    insert into "odd""name" values ('00000000-0000-0000-0000-000000000007');
  `)
  const newDialect = () => new PGliteDialect({ pglite })
  type Database = {
    userAccounts: { userNumber: number }
    'billing.orders': { orderUuid: string }
    orders: { orderUuid: string }
    'odd"name': { id: string }
    no_pk: { id: number }
    pairs: { a: number; b: number }
    amounts: { id: number }
    missing: { id: number }
    user_accounts: { user_number: number }
    'billing..orders': { id: number }
  }
  const db = new Kysely<Database>({ dialect: newDialect() })

  const names = db.withPlugin(new CamelCasePlugin())
  const tables = await discoverAuditTables(names, ['userAccounts', 'billing.orders', 'odd"name'])
  assert.deepEqual(tables, [
    { table: 'user_accounts', key: 'user_number', keyType: 'integer' },
    { schema: 'billing', table: 'orders', key: 'order_uuid', keyType: 'native-uuid' },
    { table: 'odd"name', key: 'id', keyType: 'uuid' },
  ])

  const renamed = await discoverAuditTables(names, ['userAccounts', 'billing.orders', 'odd"name'], { uuidFormat: 'short' })
  assert.deepEqual(renamed, [
    tables[0],
    tables[1],
    { table: 'odd"name', key: 'id', keyType: 'uuid', uuidFormat: 'short' },
  ])
  assert.deepEqual(await discoverAuditTables(names, ['odd"name'], { uuidFormat: 'standard' }), [
    { table: 'odd"name', key: 'id', keyType: 'uuid' },
  ])

  const events: AuditEvent[] = []
  const audit = createAudit({ mode: 'detailed', tables, writeAuditEvent: event => { events.push(event) } })
  t.after(() => audit.close())
  const monitored = new Kysely<Database>({ dialect: audit.wrapDialect(newDialect()), plugins: [new CamelCasePlugin()] })
  await monitored.selectFrom('userAccounts').select('userNumber').execute()
  await monitored.selectFrom('billing.orders').select('orderUuid').execute()
  await monitored.selectFrom('odd"name').select('id').execute()
  assert.deepEqual(events.map(event => event.tables![0]), [
    { table: 'user_accounts', ids: ['9007199254740993'], rows: 1 },
    {
      table: 'billing.orders',
      ids: ['00000000-0000-0000-0000-000000000001'],
      rows: 1,
    },
    { table: '"odd""name"', ids: ['00000000-0000-0000-0000-000000000007'], rows: 1 },
  ])

  await pglite.exec('set search_path to billing, public')
  assert.deepEqual(await discoverAuditTables(db, ['orders']), [
    { table: 'orders', key: 'order_uuid', keyType: 'native-uuid' },
  ])

  await assert.rejects(discoverAuditTables(db, ['no_pk']), /No primary key found.*no_pk/)
  await assert.rejects(discoverAuditTables(db, ['pairs']), /Composite primary keys.*pairs/)
  await assert.rejects(discoverAuditTables(db, ['amounts']), /Unsupported primary key type.*amounts/)
  await assert.rejects(discoverAuditTables(db, ['missing']), /No primary key found.*missing/)
  await assert.rejects(discoverAuditTables(names, ['userAccounts', 'user_accounts']), /Duplicate audit table name/)
  await assert.rejects(discoverAuditTables(db, ['billing..orders']), /Invalid audit table name/)
  assert.deepEqual(await discoverAuditTables(db.withSchema('billing'), ['orders']), [
    { schema: 'billing', table: 'orders', key: 'order_uuid', keyType: 'native-uuid' },
  ])
})

test('SQLite discovers main, attached and STRICT table keys and rejects nullable keys', async t => {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync | undefined = undefined
  try {
    const sqlite = await import('node:sqlite')
    DatabaseSync = sqlite.DatabaseSync
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') { throw error }

    t.skip('node:sqlite is unavailable in this Node.js version')

    return
  }

  const sqlite = new DatabaseSync(':memory:')
  t.after(() => sqlite.close())
  sqlite.exec(`
    create table users (user_number integer primary key);
    create table nullable (code text primary key);
    create table non_rowid (id integer primary key desc);
    create table loose (id int primary key not null);
    create table strict_keys (id int primary key) strict;
    attach ':memory:' as billing;
    create table billing.users (account_key text primary key not null);
  `)
  const dialect = new SqliteDialect({
    database: {
      close: () => {},
      prepare (source) {
        const statement = sqlite.prepare(source)

        return { reader: true, all: (parameters: readonly unknown[]) => statement.all(...parameters as import('node:sqlite').SQLInputValue[]) } as SqliteStatement
      },
    },
  })
  type Database = {
    users: { user_number: number }
    'billing.users': { account_key: string }
    strict_keys: { id: number }
    nullable: { code: string }
    non_rowid: { id: number }
    loose: { id: number }
  }
  const db = new Kysely<Database>({ dialect })
  t.after(() => db.destroy())

  assert.deepEqual(await discoverAuditTables(db, ['users', 'billing.users', 'strict_keys']), [
    { table: 'users', key: 'user_number', keyType: 'integer' },
    { schema: 'billing', table: 'users', key: 'account_key', keyType: 'uuid' },
    { table: 'strict_keys', key: 'id', keyType: 'integer' },
  ])
  await assert.rejects(discoverAuditTables(db, ['nullable']), /Nullable primary keys.*nullable/)
  await assert.rejects(discoverAuditTables(db, ['non_rowid']), /Nullable primary keys.*non_rowid/)
  await assert.rejects(discoverAuditTables(db, ['loose']), /Unsupported primary key type.*loose/)
})

test('MySQL discovery binds supplied names and uses the current database for bare names', async t => {
  const queries: import('kysely').CompiledQuery[] = []
  const driver = new DummyDriver()
  driver.acquireConnection = async () => ({
    executeQuery: async (query: import('kysely').CompiledQuery) => {
      queries.push(query)

      return { rows: [{ column_name: 'account_key', data_type: 'varchar' }] }
    },
  } as DatabaseConnection)
  const dialect = new MysqlDialect({ pool: () => { throw new Error('Unexpected MySQL open') } })
  dialect.createDriver = () => driver
  const db = new Kysely<{ users: { account_key: string }; 'billing.accounts': { account_key: string } }>({ dialect })
  t.after(() => db.destroy())

  assert.deepEqual(await discoverAuditTables(db, ['users', 'billing.accounts']), [
    { table: 'users', key: 'account_key', keyType: 'uuid' },
    { schema: 'billing', table: 'accounts', key: 'account_key', keyType: 'uuid' },
  ])
  assert.match(queries[0].sql, /database\(\)/i)
  assert.match(queries[0].sql, /constraint_name = 'PRIMARY'/i)
  assert.deepEqual(queries[0].parameters, ['users'])
  assert.deepEqual(queries[1].parameters, ['billing', 'accounts'])
})
