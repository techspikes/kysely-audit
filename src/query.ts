import {
  AliasNode, AndNode, BinaryOperationNode, ColumnNode, IdentifierNode, OperatorNode,
  OrNode, ParensNode, PrimitiveValueListNode, ReferenceNode, SelectQueryNode,
  TableNode, ValueListNode, ValueNode,
} from 'kysely'
import type { OperationNode } from 'kysely'
import { all, integerRanges, intersect, maxUuid, normalizeId, orderedKeyValue, union, unknown } from './range.ts'
import type { Predicate } from './range.ts'
import type { TableConfig } from './types.ts'

type Source = {
  table: TableNode
  alias?: string
  nullable: boolean
}

type TableRules = {
  table: TableConfig
  occurrences: {
    columns: readonly string[]
    nullable: boolean
    predicate: Predicate
  }[]
}

export type QueryPlan = { tables: readonly TableRules[]; unresolved: boolean }
type ComparisonRules = { exactIntegerComparisons: boolean; nativeUuidComparisons: boolean }

function isNode (value: unknown): value is OperationNode {
  return typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string'
}

function * children (node: OperationNode): Iterable<OperationNode> {
  // Value payloads are application data, even if a parameter resembles an AST node.
  if (ValueNode.is(node) || PrimitiveValueListNode.is(node)) { return }

  for (const [name, value] of Object.entries(node)) {
    if (name === 'with') { continue }

    if (isNode(value)) { yield value } else if (Array.isArray(value)) { yield * value.filter(isNode) }
  }
}

function nameOf (node: TableNode): string {
  return node.table.identifier.name
}

function tableFor (node: TableNode, tables: readonly TableConfig[]): TableConfig | undefined {
  return tables.find(table => table.table === nameOf(node) && table.schema === node.table.schema?.name)
}

function inspectTree (root: OperationNode): { tables: Set<TableNode>; opaque: boolean; selects: number } {
  const tables = new Set<TableNode>()
  let opaque = false
  let selects = 0

  function visit (node: OperationNode, ctes: ReadonlySet<string>): void {
    if (node.kind === 'RawNode') { opaque = true }

    if (SelectQueryNode.is(node)) { selects++ }

    if (ReferenceNode.is(node)) { return }

    if (TableNode.is(node)) {
      if (node.table.schema || !ctes.has(nameOf(node))) { tables.add(node) }

      return
    }

    if ('with' in node && isNode(node.with) && node.with.kind === 'WithNode') {
      const withNode = node.with as NonNullable<SelectQueryNode['with']>
      const scope = new Set(ctes)

      for (const cte of withNode.expressions) {
        const name = nameOf(cte.name.table)

        if (withNode.recursive) { scope.add(name) }

        visit(cte.expression, scope)
        scope.add(name)
      }

      ctes = scope
    }

    for (const child of children(node)) { visit(child, ctes) }
  }

  visit(root, new Set())

  return { tables, opaque, selects }
}

function getSource (node: OperationNode): Source | undefined {
  if (TableNode.is(node)) { return { table: node, nullable: false } }

  if (AliasNode.is(node) && TableNode.is(node.node) && IdentifierNode.is(node.alias)) {
    return { table: node.node, alias: node.alias.name, nullable: false }
  }
}

function matchesQualifier (source: Source, qualifier: TableNode): boolean {
  if (source.alias) { return !qualifier.table.schema && nameOf(qualifier) === source.alias }

  return nameOf(qualifier) === nameOf(source.table) &&
    (!qualifier.table.schema || qualifier.table.schema.name === source.table.table.schema?.name)
}

type KeyReference = 'key' | 'ambiguous' | 'other'

function keyReference (node: OperationNode, source: Source, key: string, sources: readonly Source[]): KeyReference {
  let qualifier: TableNode | undefined = undefined
  let name: string | undefined = undefined

  if (ReferenceNode.is(node) && ColumnNode.is(node.column)) {
    qualifier = node.table
    name = node.column.column.name
  } else if (ColumnNode.is(node)) {
    name = node.column.name
  }

  if (name !== key) { return 'other' }

  if (!qualifier) { return sources.length === 1 ? 'key' : 'ambiguous' }

  if (!matchesQualifier(source, qualifier)) { return 'other' }

  return sources.filter(candidate => matchesQualifier(candidate, qualifier)).length === 1 ? 'key' : 'ambiguous'
}

function projectedKeys (query: SelectQueryNode, source: Source, table: TableConfig, sources: readonly Source[]): string[] {
  const selections = query.selections ?? []

  if (selections.length === 1 && sources.length === 1) {
    const selection = selections[0].selection

    if (selection.kind === 'SelectAllNode' ||
      (ReferenceNode.is(selection) && selection.column.kind === 'SelectAllNode' &&
        selection.table && matchesQualifier(source, selection.table))) {
      return [table.key]
    }
  }

  const names = new Map<string, boolean>()

  for (const { selection } of selections) {
    const expression = AliasNode.is(selection) ? selection.node : selection
    let name: string | undefined = undefined

    if (AliasNode.is(selection) && IdentifierNode.is(selection.alias)) { name = selection.alias.name } else if (ReferenceNode.is(selection) && ColumnNode.is(selection.column)) { name = selection.column.column.name } else if (ColumnNode.is(selection)) { name = selection.column.name }

    // An unknown label or wildcard may overwrite a known output key.
    if (name === undefined) { return [] }

    names.set(name, !names.has(name) && keyReference(expression, source, table.key, sources) === 'key')
  }

  return [...names].filter(([, isKey]) => isKey).map(([name]) => name)
}

function literalIds (node: OperationNode, table: TableConfig): string[] | undefined {
  let values: readonly unknown[] | undefined = undefined

  if (PrimitiveValueListNode.is(node)) { values = node.values } else if (ValueListNode.is(node) && node.values.every(ValueNode.is)) { values = node.values.map(value => value.value) } else { return undefined }

  const ids = new Set<string>()

  for (const value of values) {
    if (value === null) { continue }

    const id = normalizeId(value, table.keyType, table.uuidFormat)

    if (id === undefined) { return undefined }

    ids.add(id)
  }

  return [...ids]
}

function directPredicate (operator: string, operand: OperationNode, table: TableConfig, comparisons: ComparisonRules): Predicate {
  const { keyType, exactStringEquality, uuidFormat } = table

  if (uuidFormat === 'short' || (keyType === 'string' && !exactStringEquality) ||
    (keyType === 'native-uuid' && !comparisons.nativeUuidComparisons)) {
    return unknown
  }

  const safeBound = (id: string) => keyType !== 'integer' || comparisons.exactIntegerComparisons || Number.isSafeInteger(Number(id))

  if (operator === 'in') {
    const ids = literalIds(operand, table)

    if (!ids) {
      return unknown
    }

    if (keyType === 'string') {
      return { kind: 'ids', ids }
    }

    if (!ids.every(safeBound)) {
      return unknown
    }

    return integerRanges(ids.map(id => {
      const value = orderedKeyValue(id, keyType)

      return { from: value, to: value }
    }))
  }

  if (keyType !== 'string' && operator === 'between' && AndNode.is(operand)) {
    const from = ValueNode.is(operand.left) && normalizeId(operand.left.value, keyType, uuidFormat)
    const to = ValueNode.is(operand.right) && normalizeId(operand.right.value, keyType, uuidFormat)

    return from && to && safeBound(from) && safeBound(to)
      ? integerRanges([{ from: orderedKeyValue(from, keyType), to: orderedKeyValue(to, keyType) }])
      : unknown
  }

  if (!ValueNode.is(operand)) {
    return unknown
  }

  const id = normalizeId(operand.value, keyType, uuidFormat)

  if (id === undefined) {
    return unknown
  }

  if (keyType === 'string') {
    return operator === '=' ? { kind: 'ids', ids: [id] } : unknown
  }

  if (!safeBound(id)) {
    return unknown
  }

  const value = orderedKeyValue(id, keyType)

  switch (operator) {
    case '=': return integerRanges([{ from: value, to: value }])
    case '>': return keyType !== 'integer' && value === maxUuid ? integerRanges([]) : integerRanges([{ from: value + 1n, to: null }])
    case '>=': return integerRanges([{ from: value, to: null }])
    case '<': return keyType !== 'integer' && value === 0n ? integerRanges([]) : integerRanges([{ from: null, to: value - 1n }])
    case '<=': return integerRanges([{ from: null, to: value }])
    default: return unknown
  }
}

const reversedOperators: ReadonlyMap<string, string> = new Map([
  ['=', '='], ['>', '<'], ['>=', '<='], ['<', '>'], ['<=', '>='],
])

function infer (
  node: OperationNode | undefined,
  table: TableConfig,
  source: Source,
  sources: readonly Source[],
  comparisons: ComparisonRules
): Predicate {
  if (!node) { return all }

  const inferChild = (child: OperationNode) => infer(child, table, source, sources, comparisons)

  if (ParensNode.is(node)) { return inferChild(node.node) }

  if (AndNode.is(node) || OrNode.is(node)) {
    const left = inferChild(node.left)
    const right = inferChild(node.right)

    return AndNode.is(node) ? intersect(left, right) : union(left, right)
  }

  const reference = (value: OperationNode) => keyReference(value, source, table.key, sources)

  if (BinaryOperationNode.is(node) && OperatorNode.is(node.operator)) {
    const { leftOperand: left, rightOperand: right, operator: { operator } } = node
    const leftKey = reference(left)
    const rightKey = reference(right)

    if (leftKey === 'ambiguous' || rightKey === 'ambiguous') { return unknown }

    if (ReferenceNode.is(left) && ReferenceNode.is(right) && operator === '=') { return all }

    if (leftKey === 'key') { return directPredicate(operator, right, table, comparisons) }

    if (rightKey === 'key') { return directPredicate(reversedOperators.get(operator) ?? '', left, table, comparisons) }
  }

  function mentionsKey (value: OperationNode): boolean {
    if (ReferenceNode.is(value) || ColumnNode.is(value)) { return reference(value) !== 'other' }

    for (const child of children(value)) {
      if (mentionsKey(child)) { return true }
    }

    return false
  }

  return mentionsKey(node) ? unknown : all
}

const directJoinTypes = new Set(['InnerJoin', 'LeftJoin', 'RightJoin', 'FullJoin', 'CrossJoin'])

export function analyze (root: OperationNode, configured: readonly TableConfig[], comparisons: ComparisonRules): QueryPlan {
  const tree = inspectTree(root)
  const select = SelectQueryNode.is(root) ? root : undefined
  const isRead = select || tree.selects > 0 || tree.opaque ||
    'returning' in root || 'output' in root || ('from' in root && root.kind === 'UpdateQueryNode') ||
    root.kind === 'MergeQueryNode' || (root.kind === 'DeleteQueryNode' && 'using' in root)

  if (!isRead) { return { tables: [], unresolved: false } }

  const tableRules = new Map<TableConfig, TableRules>()
  const add = (table: TableConfig, occurrence: TableRules['occurrences'][number]) => {
    const rule = tableRules.get(table)

    if (rule) { rule.occurrences.push(occurrence) } else { tableRules.set(table, { table, occurrences: [occurrence] }) }
  }

  // A bare name gives no evidence of which schema the session resolved.
  for (const node of tree.tables) {
    if (node.table.schema) { continue }

    for (const table of configured) {
      if (table.schema !== undefined && table.table === nameOf(node) && !tableRules.has(table)) {
        add(table, { columns: [], nullable: false, predicate: unknown })
      }
    }
  }

  const from = select?.from?.froms ?? []
  const joins = select?.joins ?? []
  const sources = [...from, ...joins.map(join => join.table)].map(getSource)
  const knownSources = sources.every(source => source !== undefined)
  const complex = !select || tree.opaque || tree.selects > 1 || select.with || select.setOperations ||
    select.explain || !knownSources || joins.some(join => !directJoinTypes.has(join.joinType))

  if (complex) {
    for (const node of tree.tables) {
      const table = tableFor(node, configured)

      if (table && !tableRules.has(table)) { add(table, { columns: [], nullable: false, predicate: unknown }) }
    }

    return {
      tables: [...tableRules.values()],
      unresolved: tree.opaque || !knownSources,
    }
  }

  for (const [index, join] of joins.entries()) {
    const right = from.length + index

    if (join.joinType === 'LeftJoin' || join.joinType === 'FullJoin') { sources[right].nullable = true }

    if (join.joinType === 'RightJoin' || join.joinType === 'FullJoin') {
      for (const source of sources.slice(0, right)) { source.nullable = true }
    }
  }

  const join = from.length === 1 && joins.length === 1 ? joins[0] : undefined

  for (const [index, source] of sources.entries()) {
    const table = tableFor(source.table, configured)

    if (!table) { continue }

    let predicate = infer(select.where?.where, table, source, sources, comparisons)

    if (join?.on && (join.joinType === 'InnerJoin' ||
      (join.joinType === 'LeftJoin' && index === 1) ||
      (join.joinType === 'RightJoin' && index === 0))) {
      predicate = intersect(predicate, infer(join.on.on, table, source, sources, comparisons))
    }

    add(table, {
      columns: projectedKeys(select, source, table, sources),
      nullable: source.nullable,
      predicate,
    })
  }

  return { tables: [...tableRules.values()], unresolved: false }
}
