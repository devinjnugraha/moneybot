import pg from 'pg'
import { config } from '../../config/index.js'
import { logEvent } from '../../utils/logger.js'

// DATE (OID 1082) -> 'YYYY-MM-DD' string (WIB-safe; no Date object)
// TIMESTAMP (1114) / TIMESTAMPTZ (1184) -> ISO string (no Date object)
pg.types.setTypeParser(1082, (val: string) => val) // date
pg.types.setTypeParser(1114, (val: string) => val) // timestamp
pg.types.setTypeParser(1184, (val: string) => val) // timestamptz

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL })

// Idle-client errors (Neon auto-suspends idle connections; transient network
// blips) are emitted on the pool. Without this handler Node treats them as
// unhandled emitter errors and crashes the process. Log and keep running.
pool.on('error', (err: Error) => {
  logEvent('error', 'idle db client error', { error: err.message })
})
