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

/**
 * Columns added after the first release.
 *
 * schema.sql uses CREATE TABLE IF NOT EXISTS, which does nothing to a table
 * that already exists — so a column added later never reaches a database that
 * was migrated before. That is exactly how a live server ended up without
 * `appointments.stripe_charge_id` and rejected every card booking with a SQL
 * error. Each entry below is applied only when the column is missing, so this
 * is safe to re-run and safe on a fresh install.
 */
const ADDED_COLUMNS = [
  ['appointments', 'stripe_charge_id', 'VARCHAR(120) NULL AFTER payment_intent_id'],
  ['appointments', 'stripe_transfer_id', 'VARCHAR(120) NULL AFTER stripe_charge_id'],
  ['otps', 'delivered_via', "VARCHAR(10) NOT NULL DEFAULT 'phone' AFTER type"],
  ['transactions', 'client_id', 'CHAR(36) NULL AFTER artist_id'],
  ['transactions', 'bank_details', 'JSON NULL AFTER reference'],
  ['stripe_accounts', 'transfers_enabled', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER payouts_enabled'],
]

/**
 * ENUMs that gained values after the first release. MODIFY is idempotent —
 * re-running simply sets the same definition again.
 */
const WIDENED_ENUMS = [
  [
    'transactions',
    'type',
    "ENUM('deposit','booking_payment','payout','withdrawal','refund') NOT NULL",
  ],
  [
    'transactions',
    'status',
    "ENUM('pending','in_transit','succeeded','completed','failed') NOT NULL DEFAULT 'pending'",
  ],
]

async function addMissingColumns(connection, database) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const [rows] = await connection.query(
      `SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [database, table, column]
    )
    if (rows.length) continue

    await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
    console.log(`[migrate] added ${table}.${column}`)
  }

  for (const [table, column, definition] of WIDENED_ENUMS) {
    const [rows] = await connection.query(
      `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [database, table, column]
    )
    if (!rows.length) continue

    // Only touch it when a value the code uses is not yet allowed.
    const current = String(rows[0].t)
    const needed = definition.match(/ENUM\(([^)]*)\)/i)[1].split(',').map((v) => v.trim())
    if (needed.every((value) => current.includes(value))) continue

    await connection.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`)
    console.log(`[migrate] widened ${table}.${column}`)
  }
}

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

  await addMissingColumns(connection, database)

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
