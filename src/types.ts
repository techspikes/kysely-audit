export type UuidFormat = 'standard' | 'hex' | 'short'

type TableFields = {
  table: string
  schema?: string
  key: string
  // Enable string predicate inference when SQL equality matches string identity.
  exactStringEquality?: boolean
}

export type TableConfig = Readonly<TableFields & (
  | { keyType: 'native-uuid' | 'integer' | 'string'; uuidFormat?: never }
  | { keyType: 'uuid'; uuidFormat?: UuidFormat }
)>

export type DiscoverAuditOptions = Readonly<{
  // Format for discovered text keys. Defaults to `standard`.
  uuidFormat?: UuidFormat
}>

export type TableIdentity = Readonly<{ table: string; schema?: string }>
export type Interval<T = string> = Readonly<{ from: T | null; to: T | null }>
export type AuditInterval = readonly [value: string] | readonly [from: string | null, to: string | null]
export type ReturnedBounds = readonly [min: string, max: string]

export type AuditRange =
  | Readonly<{ kind: 'ids'; ids: readonly string[] }>
  | Readonly<{ kind: 'spans'; spans: readonly AuditInterval[] }>
  | Readonly<{ kind: 'empty' | 'all' }>

export type TableSummary = Readonly<{
  table: string
  ids?: readonly string[]
  bounds?: ReturnedBounds
  pred?: AuditRange
  rows?: number
  miss?: number
  fails?: number
  overflow?: true
}>

type EventFields = Readonly<{
  at: string
  tables?: readonly TableSummary[]
  opaque?: number
  fails?: number
}>

export type StandardEvent = EventFields & Readonly<{
  end?: string
  run?: never
}>

export type DetailedEvent = EventFields & Readonly<{
  run: Readonly<{
    id: string
    start?: string
    trace?: string
    status?: 'chunk' | 'failed' | 'closed'
  }>
}>

export type AuditEvent = DetailedEvent | StandardEvent
export type AuditOptions = Readonly<{
  // Defaults to `standard`.
  mode?: 'standard' | 'detailed'
  tables: readonly TableConfig[]
  // Writes each event as JSON to stdout by default.
  writeAuditEvent?: (event: AuditEvent) => void | Promise<void>
  // Reports audit failures to stderr by default.
  onAuditError?: (error: unknown) => void | Promise<void>
}>
