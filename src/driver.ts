import type { CompiledQuery, DatabaseConnection, Dialect, Driver } from 'kysely'

export type Observation = {
  status: 'success' | 'chunk' | 'failed' | 'closed'
  rows?: readonly unknown[]
  first: boolean
}

export type Observe = (query: CompiledQuery) => (observation: Observation) => void

function wrapDriver (driver: Driver, observe: Observe): Driver {
  const wrapped = new WeakMap<DatabaseConnection, DatabaseConnection>()
  const originals = new WeakMap<DatabaseConnection, DatabaseConnection>()
  const unwrap = (connection: DatabaseConnection) => originals.get(connection) ?? connection

  function wrapConnection (connection: DatabaseConnection): DatabaseConnection {
    const existing = wrapped.get(connection)

    if (existing) { return existing }

    const wrapper: DatabaseConnection = {
      cancelQuery: connection.cancelQuery?.bind(connection),
      killSession: connection.killSession?.bind(connection),
      collectSessionInfo: connection.collectSessionInfo?.bind(connection),
      async executeQuery<R>(query: CompiledQuery, options?: Parameters<DatabaseConnection['executeQuery']>[1]) {
        const record = observe(query)
        try {
          const result = await connection.executeQuery<R>(query, options)
          record({ status: 'success', rows: result.rows, first: true })

          return result
        } catch (error) {
          record({ status: 'failed', first: true })

          throw error
        }
      },
      async * streamQuery<R>(
        query: CompiledQuery,
        chunkSize: number,
        options?: Parameters<DatabaseConnection['streamQuery']>[2]
      ) {
        const record = observe(query)
        let first = true
        let status: Observation['status'] = 'closed'
        try {
          for await (const result of connection.streamQuery<R>(query, chunkSize, options)) {
            record({ status: 'chunk', rows: result.rows, first })
            first = false
            yield result
          }

          status = 'success'
        } catch (error) {
          status = 'failed'

          throw error
        } finally {
          record({ status, rows: first && status === 'success' ? [] : undefined, first })
        }
      },
    }
    wrapped.set(connection, wrapper)
    originals.set(wrapper, connection)

    return wrapper
  }

  return {
    init: driver.init.bind(driver),
    async acquireConnection (options) {
      return wrapConnection(await driver.acquireConnection(options))
    },
    releaseConnection: (connection, options) => driver.releaseConnection(unwrap(connection), options),
    beginTransaction: (connection, settings) => driver.beginTransaction(unwrap(connection), settings),
    commitTransaction: (connection) => driver.commitTransaction(unwrap(connection)),
    rollbackTransaction: (connection) => driver.rollbackTransaction(unwrap(connection)),
    savepoint: driver.savepoint && ((connection, name, compile) => driver.savepoint!(unwrap(connection), name, compile)),
    rollbackToSavepoint: driver.rollbackToSavepoint &&
      ((connection, name, compile) => driver.rollbackToSavepoint!(unwrap(connection), name, compile)),
    releaseSavepoint: driver.releaseSavepoint &&
      ((connection, name, compile) => driver.releaseSavepoint!(unwrap(connection), name, compile)),
    destroy: driver.destroy.bind(driver),
  }
}

export function wrapDialect (dialect: Dialect, observe: Observe): Dialect {
  return {
    createAdapter: dialect.createAdapter.bind(dialect),
    createDriver: () => wrapDriver(dialect.createDriver(), observe),
    createIntrospector: dialect.createIntrospector.bind(dialect),
    createQueryCompiler: dialect.createQueryCompiler.bind(dialect),
  }
}
