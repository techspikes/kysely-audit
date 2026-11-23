import {
  MysqlAdapter, PostgresAdapter, SelectQueryNode, SelectionNode,
  SqliteAdapter, TableNode, createQueryId, sql,
} from 'kysely'
import type { DialectAdapter, Kysely, QueryExecutor, QueryExecutorProvider } from 'kysely'
import { isUuidFormat } from './range.ts'
import type { DiscoverAuditOptions, TableConfig, TableIdentity } from './types.ts'

type TableName<DB> = Extract<keyof DB, string> | `${string}.${Extract<keyof DB, string>}`

type CatalogRow = {
  column_name: string | null
  data_type: string | null
}

type SqliteCatalogRow = CatalogRow & {
  strict_table: number | bigint
  not_null: number | bigint | null
  has_primary_key_index: number | bigint
}

type KeyType = 'integer' | 'string' | 'native-uuid'
type KeyColumn = { name: string; type: KeyType | undefined; nullable?: boolean }

type Catalog = (table: TableIdentity, db: QueryExecutorProvider) => Promise<KeyColumn[]>

const postgresInteger = new Set(['int2', 'int4', 'int8'])
const postgresString = new Set(['text', 'varchar', 'bpchar'])
const mysqlInteger = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint'])
const mysqlString = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext'])

function typedColumn (dataType: string | null, integer: ReadonlySet<string>, string: ReadonlySet<string>): KeyType | undefined {
  if (dataType === null) { return undefined }

  const type = dataType.toLowerCase()

  if (integer.has(type)) { return 'integer' }

  if (string.has(type)) { return 'string' }
}

function keyColumns (rows: CatalogRow[], keyType: (row: CatalogRow) => KeyType | undefined): KeyColumn[] {
  return rows.flatMap(row => row.column_name === null ? [] : [{ name: row.column_name, type: keyType(row) }])
}

async function postgresKeys ({ schema, table }: TableIdentity, db: QueryExecutorProvider): Promise<KeyColumn[]> {
  const identifier = schema === undefined
    ? sql`pg_catalog.quote_ident(${table})`
    : sql`pg_catalog.quote_ident(${schema}) || '.' || pg_catalog.quote_ident(${table})`
  const { rows } = await sql<CatalogRow>`
    select attribute.attname as column_name, data_type.typname as data_type
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_index as pk on pk.indrelid = relation.oid and pk.indisprimary
    join lateral pg_catalog.unnest(pk.indkey) with ordinality as key_column(attnum, position)
      on key_column.position <= pk.indnkeyatts
    join pg_catalog.pg_attribute as attribute
      on attribute.attrelid = relation.oid and attribute.attnum = key_column.attnum
    left join pg_catalog.pg_type as data_type
      on data_type.oid = attribute.atttypid and data_type.typnamespace = 'pg_catalog'::pg_catalog.regnamespace
    where relation.oid = pg_catalog.to_regclass(${identifier})
      and relation.relkind in ('r', 'p')
    order by key_column.position
  `.execute(db)

  return keyColumns(rows, row =>
    row.data_type === 'uuid' ? 'native-uuid' : typedColumn(row.data_type, postgresInteger, postgresString))
}

async function mysqlKeys ({ schema, table }: TableIdentity, db: QueryExecutorProvider): Promise<KeyColumn[]> {
  const database = schema === undefined ? sql`database()` : sql.val(schema)
  const { rows } = await sql<CatalogRow>`
    select key_column.column_name as column_name, attribute.data_type as data_type
    from information_schema.key_column_usage as key_column
    join information_schema.columns as attribute
      on cast(attribute.table_schema as binary) = cast(key_column.table_schema as binary)
      and cast(attribute.table_name as binary) = cast(key_column.table_name as binary)
      and attribute.column_name = key_column.column_name
    where cast(key_column.table_schema as binary) = cast(${database} as binary)
      and cast(key_column.table_name as binary) = cast(${table} as binary)
      and key_column.constraint_name = 'PRIMARY'
    order by key_column.ordinal_position
  `.execute(db)

  return keyColumns(rows, row => typedColumn(row.data_type, mysqlInteger, mysqlString))
}

async function sqliteKeys ({ schema, table }: TableIdentity, db: QueryExecutorProvider): Promise<KeyColumn[]> {
  const schemaFilter = schema === undefined ? sql`1 = 1` : sql`candidate.schema = ${schema}`
  const { rows } = await sql<SqliteCatalogRow>`
    with target as (
      select candidate.*
      from pragma_table_list as candidate
      left join pragma_database_list as attached on attached.name = candidate.schema
      where candidate.name = ${table} and ${schemaFilter}
      order by case candidate.schema when 'temp' then 0 when 'main' then 1 else attached.seq + 2 end
      limit 1
    )
    select attribute.name as column_name, attribute.type as data_type,
      target.strict as strict_table, attribute."notnull" as not_null,
      exists (
        select 1 from pragma_index_list(target.name, target.schema) where origin = 'pk'
      ) as has_primary_key_index
    from target
    join pragma_table_xinfo(target.name, target.schema) as attribute on attribute.pk > 0
    where target.type = 'table'
    order by attribute.pk
  `.execute(db)

  return rows.flatMap(row => {
    if (row.column_name === null) { return [] }

    const dataType = row.data_type?.trim().toUpperCase() ?? ''
    const rowId = dataType === 'INTEGER' && Number(row.has_primary_key_index) === 0
    let type: KeyType | undefined = undefined

    // Ordinary SQLite columns with integer affinity can still store non-integer values.
    if (rowId || (Number(row.strict_table) === 1 && (dataType === 'INTEGER' || dataType === 'INT'))) { type = 'integer' } else if (/\b(?:CHAR|CHARACTER|VARCHAR|NCHAR|NVARCHAR|CLOB|TEXT)\b/.test(dataType)) { type = 'string' }

    return [{ name: row.column_name, type, nullable: !rowId && Number(row.not_null) !== 1 }]
  })
}

function catalogFor (adapter: DialectAdapter): Catalog {
  if (adapter instanceof PostgresAdapter) { return postgresKeys }

  if (adapter instanceof MysqlAdapter) { return mysqlKeys }

  if (adapter instanceof SqliteAdapter) { return sqliteKeys }

  throw new Error('Primary-key discovery requires a built-in PostgreSQL, PGlite, MySQL, or SQLite dialect')
}

function resolveTable (name: string, executor: QueryExecutor): TableIdentity {
  const parts = name.split('.')

  if (parts.length > 2 || parts.some(part => part.length === 0 || part.includes('\0'))) {
    throw new TypeError(`Invalid audit table name: ${JSON.stringify(name)}`)
  }

  const source = parts.length === 1 ? TableNode.create(parts[0]) : TableNode.createWithSchema(parts[0], parts[1])
  const select = SelectQueryNode.cloneWithSelections(SelectQueryNode.createFrom([source]), [SelectionNode.createSelectAll()])
  const from = executor.transformQuery(select, createQueryId()).from?.froms

  if (from?.length !== 1 || !TableNode.is(from[0])) {
    throw new Error(`Could not resolve audit table ${JSON.stringify(name)} to a base table`)
  }

  const { identifier, schema } = from[0].table

  return schema === undefined ? { table: identifier.name } : { schema: schema.name, table: identifier.name }
}

/**
 * Discover single-column primary keys for explicitly selected tables.
 * Supply names as written in monitored queries, including any schema qualifier.
 */
export async function discoverAuditTables<DB> (
  db: Kysely<DB>,
  names: readonly TableName<NoInfer<DB>>[],
  options: DiscoverAuditOptions = {}
): Promise<TableConfig[]> {
  const { uuidFormat = 'standard' } = options

  if (!isUuidFormat(uuidFormat)) {
    throw new TypeError('Invalid UUID format')
  }

  if (names.length === 0) { return [] }

  const executor = db.getExecutor()
  const tables = names.map(name => resolveTable(name, executor))
  const unique = new Set(tables.map(({ schema, table }) => JSON.stringify([schema, table])))

  if (unique.size !== tables.length) { throw new TypeError('Duplicate audit table name') }

  const catalog = catalogFor(executor.adapter)
  const metadataDb = db.withoutPlugins()
  const configured: TableConfig[] = []

  for (const [index, table] of tables.entries()) {
    const label = JSON.stringify(names[index])
    const keys = await catalog(table, metadataDb)

    if (keys.length === 0) { throw new Error(`No primary key found for audit table ${label}; verify the table name and metadata access`) }

    if (keys.length > 1) { throw new Error(`Composite primary keys are not supported for audit table ${label}`) }

    const [key] = keys

    if (key.nullable) { throw new Error(`Nullable primary keys are not supported for audit table ${label}`) }

    if (!key.type) { throw new Error(`Unsupported primary key type for audit table ${label}`) }

    const identity = { ...table, key: key.name }

    if (key.type === 'string') {
      configured.push({
        ...identity,
        keyType: 'uuid',
        ...(uuidFormat !== 'standard' && { uuidFormat }),
      })
    } else {
      configured.push({ ...identity, keyType: key.type })
    }
  }

  return configured
}
