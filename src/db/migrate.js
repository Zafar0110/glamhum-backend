 

const fs = require('fs')
const path = require('path')
const mysql = require('mysql2/promise')
const env = require('../config/env')

const FRESH = process.argv.includes('--fresh')

 
const ADDED_COLUMNS = [
  ['appointments', 'stripe_charge_id', 'VARCHAR(120) NULL AFTER payment_intent_id'],
  ['appointments', 'stripe_transfer_id', 'VARCHAR(120) NULL AFTER stripe_charge_id'],
  ['otps', 'delivered_via', "VARCHAR(10) NOT NULL DEFAULT 'phone' AFTER type"],
  ['transactions', 'client_id', 'CHAR(36) NULL AFTER artist_id'],
  ['transactions', 'bank_details', 'JSON NULL AFTER reference'],
  ['stripe_accounts', 'transfers_enabled', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER payouts_enabled'], 
  ['users', 'years_of_experience', 'TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER specialty'], 
  ['service_addons', 'currency', "CHAR(3) NOT NULL DEFAULT 'AED' AFTER price"],
  ['service_addons', 'duration', 'VARCHAR(20) NULL AFTER currency'], 
  ['users', 'slug', 'VARCHAR(160) NULL AFTER specialty'],
]

 
const ADDED_UNIQUE_INDEXES = [['users', 'uq_users_slug', 'slug']]

 
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
    // console.log(`[migrate] added ${table}.${column}`)
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
    // console.log(`[migrate] widened ${table}.${column}`)
  }
}

 
async function backfillArtistSlugs(connection) {
  const { buildArtistSlug } = require('../utils/slug')

  const [rows] = await connection.query(
    "SELECT id, first_name, last_name, username FROM users WHERE role = 'artist' AND (slug IS NULL OR slug = '')"
  )
  if (!rows.length) return

  const [existing] = await connection.query(
    'SELECT slug FROM users WHERE slug IS NOT NULL AND slug <> {}'.replace('{}', "''")
  )
  const taken = new Set(existing.map((row) => row.slug))

  for (const row of rows) {
    const base = buildArtistSlug({
      firstName: row.first_name,
      lastName: row.last_name,
      username: row.username,
    })
    if (!base) continue

    let slug = base
    let counter = 2
    while (taken.has(slug)) slug = `${base}-${counter++}`
    taken.add(slug)

    await connection.query('UPDATE users SET slug = ? WHERE id = ?', [slug, row.id])
    console.log(`[migrate] slug for ${row.username}: ${slug}`)
  }
}

async function addUniqueIndexes(connection, database) {
  for (const [table, indexName, column] of ADDED_UNIQUE_INDEXES) {
    const [rows] = await connection.query(
      `SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
      [database, table, indexName]
    )
    if (rows.length) continue

    await connection.query(
      `ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${indexName}\` (\`${column}\`)`
    )
    console.log(`[migrate] added unique index ${table}.${indexName}`)
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
  await backfillArtistSlugs(connection)
  await addUniqueIndexes(connection, database)

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
