import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { Kysely, PGliteDialect, sql } from 'kysely'
import { createAudit, discoverAuditTables, type AuditEvent, type AuditInterval, type AuditOptions } from '../src/index.ts'

type IntegerId = number | bigint
type UuidItem = { id: string; label: string }
type Database = {
  users: { id: IntegerId; name: string }
  orders: { id: IntegerId; user_id: IntegerId }
  accounts: { code: string; note: string }
  private_accounts: { code: string; note: string }
  'audit_demo.things': { id: IntegerId }
  uuid_items: UuidItem
  uuid_text_items: UuidItem
  uuid_hex_items: UuidItem
  short_uuid_items: { id: string; created_at: string }
}

const tables: AuditOptions['tables'] = [
  { table: 'users', key: 'id', keyType: 'integer' },
  { table: 'orders', key: 'id', keyType: 'integer' },
  { table: 'accounts', key: 'code', keyType: 'string', exactStringEquality: true },
  { table: 'private_accounts', key: 'code', keyType: 'string' },
  { schema: 'audit_demo', table: 'things', key: 'id', keyType: 'integer' },
  { table: 'uuid_items', key: 'id', keyType: 'native-uuid' },
  { table: 'uuid_text_items', key: 'id', keyType: 'uuid' },
  { table: 'uuid_hex_items', key: 'id', keyType: 'uuid', uuidFormat: 'hex' },
  { table: 'short_uuid_items', key: 'id', keyType: 'uuid', uuidFormat: 'short' },
]

const early = '019535d9-3df7-79fb-b466-fa907fa17f90'
const next = '019535d9-3df7-79fb-b466-fa907fa17f91'
const later = '019535d9-3df8-79fb-b466-fa907fa17f90'
const after = '019535d9-3df8-79fb-b466-fa907fa17f91'
// These Flickr Base58 UUIDv7 fixtures reverse order at the final uppercase letter.
const shortMin = '1ckw6bnAFZkQjVX4sbpJiW'
const shortMax = '1ckw6bnAFZkQjVX4sbpJiq'
const shortOutside = '1ckw6bnAFZkQjVX4sbpJjd'

async function fixture (t: TestContext, mode: AuditOptions['mode'] = 'detailed') {
  const events: AuditEvent[] = []
  const audit = createAudit({ mode, tables, writeAuditEvent: event => { events.push(event) } })
  const pglite = new PGlite()
  const db = new Kysely<Database>({ dialect: audit.wrapDialect(new PGliteDialect({ pglite })) })
  t.after(async () => {
    await db.destroy()
    await audit.close()
  })
  await pglite.exec(`
    create table users (id bigint primary key, name text not null);
    create table orders (id bigint primary key, user_id bigint not null);
    create table accounts (code text collate "C" primary key, note text not null);
    create table private_accounts (code text primary key, note text not null);
    create schema audit_demo;
    create table audit_demo.things (id bigint primary key);
    insert into users values (1, 'Alice'), (2, 'Bob'), (9007199254740993, 'Carol');
    insert into orders values (10, 1), (20, 1), (30, 999);
    insert into accounts values ('001', 'test'), ('a', 'test');
    insert into private_accounts values ('a', 'test');
    insert into audit_demo.things values (42);
    create table uuid_items (id uuid primary key, label text not null);
    insert into uuid_items values ('${early}', 'early'), ('${next}', 'next'), ('${later}', 'later'), ('${after}', 'after');
    create table uuid_text_items (id text collate "C" primary key, label text not null);
    insert into uuid_text_items select id::text, label from uuid_items;
    create table uuid_hex_items (id text collate "C" primary key, label text not null);
    insert into uuid_hex_items select replace(id::text, '-', ''), label from uuid_items;
    create table short_uuid_items (id text collate "C" primary key, created_at date not null);
    insert into short_uuid_items values
      ('${shortOutside}', '2026-10-31'), ('${shortMax}', '2026-11-01'),
      ('${shortMin}', '2026-11-02'), ('invalid', '2026-11-03');
  `)

  return { audit, db, events }
}

function scope (event: AuditEvent, table: string, source?: 'unresolved' | 'predicate' | 'returned_ids') {
  const entry = event.tables?.find(entry => entry.table === table)
  assert.ok(entry, `Missing scope for ${table}`)

  if (source === 'unresolved' || (source === undefined && entry.miss)) {
    return entry.miss
  }

  if (source === 'predicate' || entry.pred) {
    return entry.pred
  }

  return entry.ids
}

const intervals = (...bounds: AuditInterval[]) => ({
  kind: 'spans',
  spans: bounds.map(([from, to]) => from === to ? [from] : [from, to]),
})
const all = { kind: 'all' }
const unknown = 1

test('PGlite observes SELECT output, WHERE, JOIN sides, and transactions', async t => {
  const { db, events } = await fixture(t)
  const users = () => db.selectFrom('users')
  const joined = () => db.selectFrom('users as u').innerJoin('orders as o', 'o.user_id', 'u.id')

  await t.test('a query without WHERE gives all only when it needs predicate inference', async () => {
    assert.equal((await users().select('name').execute()).length, 3)
    assert.equal(events.at(-1)!.tables![0].rows, 3)
    assert.equal(events.at(-1)!.run!.trace, undefined)
    assert.deepEqual(scope(events.at(-1)!, 'users', 'predicate'), all)

    await users().selectAll().orderBy('id').execute()
    assert.deepEqual(scope(events.at(-1)!, 'users', 'returned_ids'), ['1', '2', '9007199254740993'])

    await users().select('id').where('id', '=', 999).execute()
    assert.deepEqual(scope(events.at(-1)!, 'users'), undefined)
  })

  await t.test('returns keys per table and preserves unmatched JOIN candidates', async () => {
    const results = await joined().select(['u.id as user_id', 'o.id as order_id']).orderBy('o.id').execute()
    assert.deepEqual(results, [{ user_id: 1, order_id: 10 }, { user_id: 1, order_id: 20 }])
    assert.deepEqual(scope(events.at(-1)!, 'users'), ['1'])
    assert.deepEqual(scope(events.at(-1)!, 'orders'), ['10', '20'])

    await joined().select('u.id as user_id').execute()
    assert.deepEqual(scope(events.at(-1)!, 'users'), ['1'])
    assert.deepEqual(scope(events.at(-1)!, 'orders'), all)

    await joined().select(['u.id', 'o.id']).where('u.id', '=', 1).execute()
    assert.deepEqual(scope(events.at(-1)!, 'users'), intervals(['1', '1']))
    assert.deepEqual(scope(events.at(-1)!, 'orders'), all)

    await db.selectFrom('users as u').innerJoin('orders as o', 'o.id', 'u.id')
      .select('u.name').where('u.id', '=', 1).execute()
    assert.deepEqual(scope(events.at(-1)!, 'users'), intervals(['1', '1']))
    assert.deepEqual(scope(events.at(-1)!, 'orders'), all)
  })

  await t.test('only uses outer JOIN ON restrictions for unpreserved sides', async () => {
    const left = () => db.selectFrom('users as u').leftJoin('orders as o', join =>
      join.onRef('o.user_id', '=', 'u.id').on('o.id', 'in', [10, 20]).on('u.id', '=', 1))
    await left().select('u.name').execute()
    assert.deepEqual(scope(events.at(-1)!, 'users'), all)
    assert.deepEqual(scope(events.at(-1)!, 'orders'), intervals(['10', '10'], ['20', '20']))

    const rows = await left().select('o.id as order_id').orderBy('o.id').execute()
    assert.ok(rows.some(row => row.order_id === null))
    assert.deepEqual(scope(events.at(-1)!, 'orders'), ['10', '20'])

    await db.selectFrom('users as u').rightJoin('orders as o', join =>
      join.onRef('o.user_id', '=', 'u.id').on('o.id', '=', 10).on('u.id', '=', 1))
      .select('u.name').execute()
    assert.deepEqual(scope(events.at(-1)!, 'users'), intervals(['1', '1']))
    assert.deepEqual(scope(events.at(-1)!, 'orders'), all)

    await db.selectFrom('users as u').fullJoin('orders as o', join =>
      join.onRef('o.user_id', '=', 'u.id').on('o.id', '=', 10)).select('u.name').execute()
    assert.deepEqual(scope(events.at(-1)!, 'users'), all)
    assert.deepEqual(scope(events.at(-1)!, 'orders'), all)
  })

  await t.test('calculates predicate bounds and retains unsupported conditions', async () => {
    await users().select('name').where(eb => eb.or([
      eb.and([eb('id', '>', 0), eb.between('id', 1, 2)]),
      eb('id', '=', 9007199254740993n),
    ])).execute()
    assert.deepEqual(scope(events.at(-1)!, 'users'), intervals(['1', '2'], ['9007199254740993', '9007199254740993']))

    await users().select('name').where('id', '!=', 1).execute()
    assert.deepEqual(scope(events.at(-1)!, 'users', 'unresolved'), unknown)

    await db.selectFrom('accounts').select('note').where('code', 'in', ['001', 'a']).execute()
    assert.deepEqual(scope(events.at(-1)!, 'accounts', 'predicate'), { kind: 'ids', ids: ['001', 'a'] })
    await db.selectFrom('private_accounts').select('note').where('code', '=', 'a').execute()
    assert.deepEqual(scope(events.at(-1)!, 'private_accounts', 'unresolved'), unknown)
  })

  await t.test('handles qualified names, opaque SQL, and CTE shadowing', async () => {
    await db.selectFrom('audit_demo.things').selectAll().execute()
    assert.deepEqual(scope(events.at(-1)!, 'audit_demo.things'), ['42'])

    await db.with('users', scoped => scoped.selectFrom('users').select('id'))
      .selectFrom('users').selectAll().execute()
    assert.deepEqual(scope(events.at(-1)!, 'users', 'unresolved'), unknown)

    const opaque = await sql`select name from users where id = ${1}`.execute(db)
    assert.deepEqual(opaque.rows, [{ name: 'Alice' }])
    assert.ok(events.at(-1)!.opaque)
    assert.equal(events.at(-1)!.tables, undefined)
    assert.doesNotMatch(JSON.stringify(events), /Alice|select name from/i)
  })

  await t.test('observes compiled execution and delegates savepoints', async () => {
    const count = events.length
    const compiled = users().select('id').where('id', '=', 1).compile()
    assert.equal(events.length, count)
    await db.executeQuery(compiled)
    await db.executeQuery(compiled)
    assert.notEqual(events.at(-2)!.run!.id, events.at(-1)!.run!.id)
    assert.equal(events.length, count + 2)

    const transaction = await db.startTransaction().execute()
    try {
      const saved = await transaction.savepoint('audit_check').execute()
      assert.deepEqual(await saved.selectFrom('users').select('id').where('id', '=', 1).execute(), [{ id: 1 }])
      await saved.rollbackToSavepoint('audit_check').execute()
    } finally {
      await transaction.rollback().execute()
    }

    assert.deepEqual(scope(events.at(-1)!, 'users'), ['1'])
  })
})

test('PGlite evaluates UUIDv7 bounds in native UUID order', async t => {
  const { db, events } = await fixture(t)
  const select = () => db.selectFrom('uuid_items').select('label')
  const rows = await select().where(eb => eb.or([
    eb.between('id', early, next),
    eb('id', '=', later),
  ])).orderBy('id').execute()
  assert.deepEqual(rows.map(row => row.label), ['early', 'next', 'later'])
  assert.deepEqual(scope(events.at(-1)!, 'uuid_items'), intervals([early, next], [later, later]))

  const exclusive = await select().where('id', '>', early).where('id', '<', after).orderBy('id').execute()
  assert.deepEqual(exclusive.map(row => row.label), ['next', 'later'])
  assert.deepEqual(scope(events.at(-1)!, 'uuid_items'), intervals([next, later]))

  await select().where('id', '=', '{' + early.toUpperCase().replaceAll('-', '') + '}').execute()
  assert.deepEqual(scope(events.at(-1)!, 'uuid_items'), intervals([early, early]))

  for (const [operator, bound] of [
    ['<', '00000000-0000-0000-0000-000000000000'],
    ['>', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
  ] as const) {
    assert.deepEqual(await select().where('id', operator, bound).execute(), [])
    assert.deepEqual(scope(events.at(-1)!, 'uuid_items'), { kind: 'empty' })
  }
})

test('PGlite infers UUIDv7 text bounds only from canonical literals', async t => {
  const { db, events } = await fixture(t)
  const select = () => db.selectFrom('uuid_text_items').select('label')
  const [discovered] = await discoverAuditTables(db, ['uuid_text_items'])
  assert.equal(discovered.keyType, 'uuid')

  const rows = await select().where('id', '>', early).where('id', '<', after).orderBy('id').execute()
  assert.deepEqual(rows.map(row => row.label), ['next', 'later'])
  assert.deepEqual(scope(events.at(-1)!, 'uuid_text_items'), intervals([next, later]))

  const noncanonical = await select().where('id', '>', early.toUpperCase()).orderBy('id').execute()
  assert.deepEqual(noncanonical.map(row => row.label), ['early', 'next', 'later', 'after'])
  assert.deepEqual(scope(events.at(-1)!, 'uuid_text_items', 'unresolved'), unknown)
})

test('PGlite emits 32-character UUID bounds using the stored hex format', async t => {
  const { db, events } = await fixture(t)
  const hex = (id: string) => id.replaceAll('-', '')
  const [table] = await discoverAuditTables(db, ['uuid_hex_items'], { uuidFormat: 'hex' })
  assert.deepEqual(table, { table: 'uuid_hex_items', key: 'id', keyType: 'uuid', uuidFormat: 'hex' })

  const select = () => db.selectFrom('uuid_hex_items').select('label')
  const rows = await select().where('id', '>', hex(early)).where('id', '<', hex(after)).orderBy('id').execute()
  assert.deepEqual(rows.map(row => row.label), ['next', 'later'])
  assert.deepEqual(scope(events.at(-1)!, 'uuid_hex_items'), intervals([hex(next), hex(later)]))

  await select().where(eb => eb.between('id', hex(early), hex(next))).execute()
  assert.deepEqual(scope(events.at(-1)!, 'uuid_hex_items'), intervals([hex(early), hex(next)]))
})

test('PGlite derives detailed ShortUUID bounds from a non-key date filter', async t => {
  const { db, events } = await fixture(t)
  const select = () => db.selectFrom('short_uuid_items').select('id')
    .where('created_at', '>=', '2026-11-01').where('created_at', '<', '2026-11-03')
  assert.deepEqual((await select().orderBy('created_at').execute()).map(row => row.id), [shortMax, shortMin])
  assert.deepEqual(events.at(-1)!.tables![0], {
    table: 'short_uuid_items',
    ids: [shortMax, shortMin],
    rows: 2,
    bounds: [shortMin, shortMax],
  })
  assert.deepEqual((await select().orderBy('id').execute()).map(row => row.id), [shortMin, shortMax])
  const caseFoldedOrder = await select().orderBy(eb => eb.fn('lower', ['id'])).execute()
  assert.deepEqual(caseFoldedOrder.map(row => row.id), [shortMax, shortMin])
  assert.deepEqual(events.at(-1)!.tables![0].bounds, [shortMin, shortMax])

  const rows = await db.selectFrom('short_uuid_items').select('id').where('created_at', '=', '2026-11-03').execute()
  assert.deepEqual(rows, [{ id: 'invalid' }])
  assert.deepEqual(events.at(-1)!.tables, [{
    table: 'short_uuid_items', miss: 1, rows: 1,
  }])
})

test('PGlite produces a standard summary with both sources and opaque execution counts', async t => {
  const { audit, db, events } = await fixture(t, 'standard')
  await db.selectFrom('users').select('id').where('id', '=', 2).execute()
  await db.selectFrom('users').select('name').where('id', 'in', [1, 5]).execute()
  await db.selectFrom('users').select('name').where('id', '=', 9007199254740993n).execute()
  const uuidTables = ['uuid_items', 'uuid_text_items'] as const

  for (const table of uuidTables) {
    await db.selectFrom(table).select('label').where('id', 'in', [early, later]).execute()
    await db.selectFrom(table).select('label').where('id', '<=', early).where('id', '>=', early).execute()
    await db.selectFrom(table).select('label').where('id', '=', after).execute()
    await db.selectFrom(table).select('id').where('id', '=', next).execute()
  }

  for (const day of ['2026-11-01', '2026-11-02']) {
    await db.selectFrom('short_uuid_items').select('id').where('created_at', '=', day).execute()
  }

  await sql`select id from users`.execute(db)
  await assert.rejects(sql`select id from missing_table`.execute(db))
  await audit.close()

  assert.equal(events.length, 1)
  assert.equal(events[0].run, undefined)
  assert.equal(events[0].opaque, 2)
  assert.equal(events[0].fails, 1)
  assert.deepEqual(events[0].tables![0], {
    table: 'users',
    ids: ['2'],
    pred: { kind: 'spans', spans: [['1', '9007199254740993']] },
    rows: 3,
  })
  assert.deepEqual(events[0].tables!.slice(1, -1), uuidTables.map(table => ({
    table,
    ids: [next],
    pred: { kind: 'spans', spans: [[early, after]] },
    rows: 5,
  })))
  assert.deepEqual(events[0].tables!.at(-1), {
    table: 'short_uuid_items',
    ids: [shortMax, shortMin],
    bounds: [shortMin, shortMax],
    rows: 2,
  })
})
