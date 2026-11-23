import type {
  AuditInterval, AuditRange, Interval, TableConfig, UuidFormat,
} from './types.ts'

export type Predicate =
  | { kind: 'all' }
  | { kind: 'unknown' }
  | { kind: 'ids'; ids: readonly string[] }
  | { kind: 'intervals'; intervals: readonly Interval<bigint>[] }

export const all = { kind: 'all' } as const
export const unknown = { kind: 'unknown' } as const
export const maxUuid = (1n << 128n) - 1n

export function isUuidFormat (value: unknown): value is UuidFormat {
  return value === 'standard' || value === 'hex' || value === 'short'
}

export function hasShortUuidFormat (value: unknown): value is string {
  return typeof value === 'string' && value.length === 22 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
}

function normalizeUuid (value: unknown, allowAlternate: boolean): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) {
    return value
  }

  if (!allowAlternate) {
    return undefined
  }

  const digits = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value

  if (!/^(?:[0-9a-f]{4}-?){7}[0-9a-f]{4}$/i.test(digits)) {
    return undefined
  }

  return formatUuid(digits.replaceAll('-', '').toLowerCase())
}

function formatUuid (hex: string): string {
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export function normalizeId (value: unknown, keyType: TableConfig['keyType'], uuidFormat?: UuidFormat): string | undefined {
  if (keyType === 'uuid' && uuidFormat === 'hex') {
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : undefined
  }

  if (keyType === 'native-uuid' || keyType === 'uuid') {
    // Text comparisons preserve spelling, while native UUID comparisons normalize it.
    return normalizeUuid(value, keyType === 'native-uuid')
  }

  if (keyType === 'string') { return typeof value === 'string' ? value : undefined }

  if (typeof value === 'bigint') { return value.toString() }

  if (typeof value === 'number' && Number.isSafeInteger(value)) { return value.toString() }

  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) { return BigInt(value).toString() }

  return undefined
}

export function orderedKeyValue (id: string, keyType: Exclude<TableConfig['keyType'], 'string'>): bigint {
  return keyType === 'integer' ? BigInt(id) : BigInt('0x' + id.replaceAll('-', ''))
}

type IntegerInterval = Interval<bigint>

function compareLower (a: bigint | null, b: bigint | null): number {
  if (a === b) { return 0 }

  if (a === null) { return -1 }

  if (b === null) { return 1 }

  return a < b ? -1 : 1
}

function compareUpper (a: bigint | null, b: bigint | null): number {
  if (a === null || b === null) { return -compareLower(a, b) }

  return compareLower(a, b)
}

function valid ({ from, to }: IntegerInterval): boolean {
  return from === null || to === null || from <= to
}

export function integerRanges (intervals: IntegerInterval[]): Predicate {
  const sorted = intervals.filter(valid).sort((a, b) => compareLower(a.from, b.from))
  const merged: IntegerInterval[] = []

  for (const interval of sorted) {
    const last = merged.at(-1)

    if (!last || (last.to !== null && interval.from !== null && last.to + 1n < interval.from)) {
      merged.push(interval)
    } else if (compareUpper(interval.to, last.to) > 0) {
      merged[merged.length - 1] = { from: last.from, to: interval.to }
    }
  }

  return merged.length === 1 && merged[0].from === null && merged[0].to === null
    ? all
    : { kind: 'intervals', intervals: merged }
}

function intersectIntervals (left: readonly IntegerInterval[], right: readonly IntegerInterval[]): Predicate {
  const intervals: IntegerInterval[] = []
  let i = 0
  let j = 0

  while (i < left.length && j < right.length) {
    const a = left[i]
    const b = right[j]
    const endOrder = compareUpper(a.to, b.to)
    const intersection = {
      from: compareLower(a.from, b.from) >= 0 ? a.from : b.from,
      to: endOrder <= 0 ? a.to : b.to,
    }

    if (valid(intersection)) { intervals.push(intersection) }

    if (endOrder <= 0) { i++ }

    if (endOrder >= 0) { j++ }
  }

  return { kind: 'intervals', intervals }
}

export function intersect (a: Predicate, b: Predicate): Predicate {
  if (a.kind === 'all' || a.kind === 'unknown') { return b.kind === 'all' ? a : b }

  if (b.kind === 'all' || b.kind === 'unknown') { return a }

  if (a.kind === 'intervals' && b.kind === 'intervals') { return intersectIntervals(a.intervals, b.intervals) }

  if (a.kind === 'ids' && b.kind === 'ids') {
    const allowed = new Set(b.ids)

    return { kind: 'ids', ids: a.ids.filter(id => allowed.has(id)) }
  }

  return unknown
}

export function union (a: Predicate, b: Predicate): Predicate {
  if (a.kind === 'all' || b.kind === 'all') { return all }

  if (a.kind === 'intervals' && b.kind === 'intervals') { return integerRanges([...a.intervals, ...b.intervals]) }

  if (a.kind === 'ids' && b.kind === 'ids') { return { kind: 'ids', ids: [...new Set([...a.ids, ...b.ids])] } }

  return unknown
}

export function unionBounds (current: Predicate | null, next: Predicate): Predicate {
  if (next.kind !== 'intervals' || (current && current.kind !== 'intervals')) {
    return current ? union(current, next) : next
  }

  // Predicate intervals are ordered and non-overlapping.
  const first = next.intervals[0]
  const last = next.intervals.at(-1)

  if (!first || !last) {
    return current ?? next
  }

  const lower = current?.intervals[0]
  const upper = current?.intervals.at(-1)
  const from = lower && compareLower(lower.from, first.from) < 0 ? lower.from : first.from
  const to = upper && compareUpper(upper.to, last.to) > 0 ? upper.to : last.to

  return from === null && to === null ? all : { kind: 'intervals', intervals: [{ from, to }] }
}

type KeyFormat = Pick<TableConfig, 'keyType' | 'uuidFormat'>

function formatBound (value: bigint, { keyType, uuidFormat }: KeyFormat): string {
  if (keyType === 'native-uuid' || keyType === 'uuid') {
    const hex = value.toString(16).padStart(32, '0')

    return keyType === 'uuid' && uuidFormat === 'hex' ? hex : formatUuid(hex)
  }

  return value.toString()
}

function serializeInterval ({ from, to }: IntegerInterval, key: KeyFormat): AuditInterval {
  return from !== null && from === to
    ? [formatBound(from, key)]
    : [from === null ? null : formatBound(from, key), to === null ? null : formatBound(to, key)]
}

export function serialize (range: Predicate, key: KeyFormat): AuditRange | undefined {
  switch (range.kind) {
    case 'unknown': return undefined
    case 'all': return range
    case 'ids': return range.ids.length === 0 ? { kind: 'empty' } : range
    case 'intervals':
      return range.intervals.length === 0
        ? { kind: 'empty' }
        : { kind: 'spans', spans: range.intervals.map(interval => serializeInterval(interval, key)) }
  }
}

export function rangeSize (range: Predicate): number {
  switch (range.kind) {
    case 'ids': return range.ids.length
    case 'intervals': return range.intervals.length
    case 'all':
    case 'unknown': return 0
  }
}
