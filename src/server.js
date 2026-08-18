const http = require('http')
const app = require('./app')
const env = require('./config/env')
const { testConnection, pool } = require('./config/db')
const sockets = require('./sockets')

const server = http.createServer(app)
sockets.init(server)

async function start() {
  
  try {
    await testConnection()
    console.log(`[db]     connected to ${env.db.database} @ ${env.db.host}:${env.db.port}`)
  } catch (error) {
    console.warn(`[db]     NOT connected: ${error.code || error.message}`)
    console.warn('[db]     check .env, then run: npm run db:migrate')
  }

  server.listen(env.port, () => {
    console.log(`[server] ${env.nodeEnv} mode on http://localhost:${env.port}`)
    console.log(`[server] api      http://localhost:${env.port}${env.apiPrefix}`)
    console.log(`[server] health   http://localhost:${env.port}${env.apiPrefix}/health`)
    console.log(`[server] cors     ${env.clientUrls.join(', ')}`)
  })
}

async function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down`)
  server.close(async () => {
    await pool.end().catch(() => {})
    process.exit(0)
  })
  
  setTimeout(() => process.exit(1), 10000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason))

start()
