// Platform settings the admin edits at runtime.
//
// The booking service fee used to be a `const SERVICE_FEE = 150` copied into
// three files — two on the server, one on the booking screen. Any drift between
// them would have shown the client one total and charged another. It now lives
// in one table row, read through here.

const { query, queryOne } = require('../config/db')
const env = require('../config/env')

/**
 * Every setting, with the value used when the row is missing and the bounds a
 * new value has to fall inside. `env` supplies the commission default so an
 * existing deployment keeps the number it was configured with.
 */
const DEFINITIONS = {
  serviceFee: {
    key: 'service_fee',
    fallback: 150,
    min: 0,
    max: 10000,
    label: 'Service fee',
  },
  commissionPercent: {
    key: 'commission_percent',
    fallback: Number(env.stripe.commissionPercent) || 10,
    min: 0,
    max: 100,
    label: 'Commission percent',
  },
}

/**
 * Cached briefly: the fee is read on every booking and price quote, and it
 * changes about never. A short TTL means an admin's edit takes effect straight
 * away without a restart.
 */
const CACHE_TTL_MS = 30_000
let cache = null
let cachedAt = 0

function clampNumber(value, { min, max }) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(max, Math.max(min, Math.round(number * 100) / 100))
}

/** All settings, falling back to the defaults for anything unset. */
async function getSettings() {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache

  let rows = []
  try {
    rows = await query('SELECT setting_key, setting_value FROM settings')
  } catch {
    // Table missing (migration not run yet) — the defaults still work.
    rows = []
  }

  const stored = new Map(rows.map((row) => [row.setting_key, row.setting_value]))
  const settings = {}

  for (const [name, definition] of Object.entries(DEFINITIONS)) {
    const raw = stored.get(definition.key)
    const parsed = raw === undefined ? null : clampNumber(raw, definition)
    settings[name] = parsed === null ? definition.fallback : parsed
  }

  cache = settings
  cachedAt = Date.now()
  return settings
}

/** The booking service fee, in AED. */
async function getServiceFee() {
  const { serviceFee } = await getSettings()
  return serviceFee
}

/** The platform's cut of the services subtotal, as a percentage. */
async function getCommissionPercent() {
  const { commissionPercent } = await getSettings()
  return commissionPercent
}

/**
 * Write the settings an admin submitted. Returns { settings, errors } rather
 * than throwing, so the caller decides how to report a bad value.
 */
async function updateSettings(patch, adminId) {
  const errors = {}
  const writes = []

  for (const [name, definition] of Object.entries(DEFINITIONS)) {
    if (patch[name] === undefined) continue

    const value = clampNumber(patch[name], definition)
    if (value === null) {
      errors[name] = `${definition.label} must be a number`
      continue
    }
    if (Number(patch[name]) < definition.min || Number(patch[name]) > definition.max) {
      errors[name] = `${definition.label} must be between ${definition.min} and ${definition.max}`
      continue
    }

    writes.push([definition.key, String(value)])
  }

  if (Object.keys(errors).length) return { errors, settings: await getSettings() }

  for (const [key, value] of writes) {
    await query(
      `INSERT INTO settings (setting_key, setting_value, updated_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      [key, value, adminId || null]
    )
  }

  invalidate()
  return { errors: null, settings: await getSettings() }
}

/** Drop the cache so the next read hits the database. */
function invalidate() {
  cache = null
  cachedAt = 0
}

/** When each setting was last changed, and by whom — shown on the admin page. */
async function getMetadata() {
  try {
    const row = await queryOne(
      `SELECT s.setting_key, s.updated_at, u.first_name, u.last_name
         FROM settings s LEFT JOIN users u ON u.id = s.updated_by
        ORDER BY s.updated_at DESC LIMIT 1`
    )
    if (!row) return null
    return {
      updatedAt: row.updated_at,
      updatedBy: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    }
  } catch {
    return null
  }
}

module.exports = {
  DEFINITIONS,
  getSettings,
  getServiceFee,
  getCommissionPercent,
  updateSettings,
  getMetadata,
  invalidate,
}
