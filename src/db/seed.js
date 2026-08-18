 

const bcrypt = require('bcryptjs')
const { v4: uuid } = require('uuid')
const env = require('../config/env')
const { query, queryOne, pool } = require('../config/db')

const PASSWORD = '123123123'

const ACCOUNTS = [
  {
    firstName: 'Admin',
    lastName: 'User',
    username: 'admin',
    email: 'admin@gmail.com',
    role: 'admin',
  },
  {
    firstName: 'Sarah',
    lastName: 'Johnson',
    username: 'sarahjohnson',
    email: 'artist@gmail.com',
    role: 'artist',
    city: 'Dubai',
    address: 'Jumeirah Beach Road, Dubai',
    hasStudio: 1,
    specialty: 'makeup',
    description: 'Bridal makeup and hair specialist based in Dubai.',
    minPrice: 550,
    approvalStatus: 'approved',
  },
  {
    firstName: 'Aisha',
    lastName: 'Rahman',
    username: 'aisharahman',
    email: 'client@gmail.com',
    role: 'client',
  },
]

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, env.bcryptRounds)

  for (const account of ACCOUNTS) {
    const existing = await queryOne('SELECT id FROM users WHERE email = ? LIMIT 1', [account.email])
    if (existing) {
      console.log(`[seed] skip ${account.email} (already exists)`)
      continue
    }

    const id = uuid()
    await query(
      `INSERT INTO users
         (id, first_name, last_name, username, email, password_hash, role,
          is_email_verified, is_phone_verified, agreed_to_privacy,
          city, address, has_studio, description, specialty, min_price,
          currency, approval_status, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?, ?, 'AED', ?, ?)`,
      [
        id,
        account.firstName,
        account.lastName,
        account.username,
        account.email,
        passwordHash,
        account.role,
        account.city || null,
        account.address || null,
        account.hasStudio ?? null,
        account.description || null,
        account.specialty || null,
        account.minPrice || null,
        account.approvalStatus || null,
        account.approvalStatus === 'approved' ? new Date() : null,
      ]
    )
    console.log(`[seed] created ${account.role.padEnd(6)} ${account.email}`)
  }

  console.log(`\n[seed] done. Password for all seeded accounts: ${PASSWORD}`)
}

main()
  .then(async () => {
    await pool.end()
    process.exit(0)
  })
  .catch(async (error) => {
    console.error('[seed] failed:', error.message)
    await pool.end().catch(() => {})
    process.exit(1)
  })
