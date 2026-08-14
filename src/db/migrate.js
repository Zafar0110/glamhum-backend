// Creates the database (if missing) and applies src/db/schema.sql.
//
//   npm run db:migrate            apply schema (safe to re-run)
//   npm run db:migrate -- --fresh DROP the database first, then apply
//
// --fresh destroys all data; it prompts for nothing, so use it deliberately.

const fs = require('fs')
const path = require('path')
const mysql = require('mysql2/promise')
const env = require('../config/env')

const FRESH = process.argv.includes('--fresh')

async function main() {
  const { host, port, user, password, database } = env.db

  console.log(`[migrate] connecting to mysql://${user}@${host}:${port}`)
  const connection = await mysql.createConnection({
    host,
    port,
    user,
    password,
    multipleStatements: true,
  })

  if (FRESH) {
    console.log(`[migrate] --fresh: dropping database \`${database}\``)
    await connection.query(`DROP DATABASE IF EXISTS \`${database}\``)
  }

  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  )
  console.log(`[migrate] database \`${database}\` ready`)

  await connection.changeUser({ database })

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  await connection.query(schema)
  console.log('[migrate] schema applied')

  const [tables] = await connection.query('SHOW TABLES')
  console.log(`[migrate] ${tables.length} tables:`, tables.map((row) => Object.values(row)[0]).join(', '))

  await connection.end()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[migrate] failed:', error.message)
    if (error.code === 'ECONNREFUSED') {
      console.error('[migrate] is MySQL running, and do DB_HOST/DB_PORT in .env match?')
    }
    if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('[migrate] check DB_USER / DB_PASSWORD in .env')
    }
    process.exit(1)
  })
