// The signed-in artist's service catalogue (onboarding step 2 + the dashboard
// "My Services" tab).

const { v4: uuid } = require('uuid')
const { query, queryOne, transaction } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success } = require('../utils/response')
const { serializeService } = require('../utils/serializers')

/** '2h 30m' -> 150. Stored alongside the display string for scheduling maths. */
function durationToMinutes(duration = '') {
  const hours = /(\d+)\s*h/i.exec(duration)
  const minutes = /(\d+)\s*m/i.exec(duration)
  const total = (hours ? parseInt(hours[1], 10) * 60 : 0) + (minutes ? parseInt(minutes[1], 10) : 0)
  return total || null
}

function validateService(body, { partial = false } = {}) {
  const errors = {}
  const has = (field) => body[field] !== undefined && body[field] !== null && body[field] !== ''

  if (!partial || has('serviceName')) {
    if (!body.serviceName || !String(body.serviceName).trim()) {
      errors.serviceName = 'Service name is required'
    }
  }
  if (!partial || has('serviceType')) {
    if (!body.serviceType || !String(body.serviceType).trim()) {
      errors.serviceType = 'Please choose a service type'
    }
  }
  if (!partial || has('price')) {
    const price = Number(body.price)
    if (Number.isNaN(price)) errors.price = 'Enter a valid price'
    else if (price < 0) errors.price = 'Price cannot be negative'
  }
  if (!partial || has('duration')) {
    if (!body.duration || !String(body.duration).trim()) errors.duration = 'Please choose a duration'
  }

  if (Object.keys(errors).length) throw ApiError.validation(errors)
}

/** Attach add-ons to a list of services in ONE query (no N+1). */
async function withAddOns(serviceRows) {
  if (!serviceRows.length) return []

  const ids = serviceRows.map((row) => row.id)
  const placeholders = ids.map(() => '?').join(',')
  const addOns = await query(
    `SELECT id, service_id, name, price FROM service_addons WHERE service_id IN (${placeholders})`,
    ids
  )

  const byService = new Map()
  for (const addOn of addOns) {
    if (!byService.has(addOn.service_id)) byService.set(addOn.service_id, [])
    byService.get(addOn.service_id).push(addOn)
  }

  return serviceRows.map((row) => serializeService(row, byService.get(row.id) || []))
}

/** Replace a service's add-ons inside an existing transaction connection. */
async function replaceAddOns(connection, serviceId, addOns) {
  await connection.execute('DELETE FROM service_addons WHERE service_id = ?', [serviceId])

  const rows = (addOns || []).filter((addOn) => addOn && String(addOn.name || '').trim())
  for (const addOn of rows) {
    await connection.execute(
      'INSERT INTO service_addons (id, service_id, name, price) VALUES (?, ?, ?, ?)',
      [uuid(), serviceId, String(addOn.name).trim(), Number(addOn.price) || 0]
    )
  }
}

/** Confirm the service exists AND belongs to the caller. */
async function ownedService(serviceId, artistId) {
  const service = await queryOne('SELECT * FROM services WHERE id = ? LIMIT 1', [serviceId])
  if (!service) throw ApiError.notFound('Service not found')
  if (service.artist_id !== artistId) throw ApiError.forbidden('This service belongs to another artist')
  return service
}

/**
 * GET /api/services?status=active|archived|all
 * Defaults to active. Archived services keep their data but are hidden from
 * clients and excluded from the artist's "from" price.
 */
exports.getMyServices = async (req, res) => {
  const status = ['active', 'archived', 'all'].includes(req.query.status) ? req.query.status : 'active'

  const where =
    status === 'all' ? '' : status === 'archived' ? 'AND is_active = 0' : 'AND is_active = 1'

  const rows = await query(
    `SELECT * FROM services WHERE artist_id = ? ${where} ORDER BY created_at ASC`,
    [req.user.id]
  )

  const services = await withAddOns(rows)
  return success(res, { services }, 'OK', 200, { count: services.length, total: services.length })
}

/** GET /api/services/:id */
exports.getServiceById = async (req, res) => {
  const service = await ownedService(req.params.id, req.user.id)
  const [withOns] = await withAddOns([service])
  return success(res, { service: withOns })
}

/** POST /api/services */
exports.createService = async (req, res) => {
  validateService(req.body)

  const id = uuid()
  const body = req.body

  await transaction(async (connection) => {
    await connection.execute(
      `INSERT INTO services
         (id, artist_id, service_name, service_description, service_type,
          price_type, price, currency, duration, duration_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.user.id,
        String(body.serviceName).trim(),
        body.serviceDescription ? String(body.serviceDescription).trim() : null,
        String(body.serviceType).trim().toLowerCase(),
        body.priceType ? String(body.priceType).trim() : 'fixed',
        Number(body.price) || 0,
        body.currency || 'AED',
        String(body.duration).trim(),
        durationToMinutes(body.duration),
      ]
    )
    await replaceAddOns(connection, id, body.addOns)
  })

  // Keep the artist's "from" price in step with their cheapest service.
  await refreshMinPrice(req.user.id)

  const service = await ownedService(id, req.user.id)
  const [withOns] = await withAddOns([service])

  // `id`/`_id` are repeated at the top level because the onboarding screen
  // reads response.data.id straight off the envelope.
  return success(res, { service: withOns, id, _id: id }, 'Service created successfully', 201)
}

/** PATCH /api/services/:id */
exports.updateService = async (req, res) => {
  await ownedService(req.params.id, req.user.id)
  validateService(req.body, { partial: true })

  const map = {
    serviceName: 'service_name',
    serviceDescription: 'service_description',
    serviceType: 'service_type',
    priceType: 'price_type',
    price: 'price',
    currency: 'currency',
    duration: 'duration',
  }

  const sets = []
  const values = []

  for (const [field, column] of Object.entries(map)) {
    if (req.body[field] === undefined) continue
    let value = req.body[field]
    if (field === 'serviceType') value = String(value).trim().toLowerCase()
    if (field === 'price') value = Number(value) || 0
    values.push(value)
    sets.push(`${column} = ?`)
  }

  if (req.body.duration !== undefined) {
    sets.push('duration_minutes = ?')
    values.push(durationToMinutes(req.body.duration))
  }

  await transaction(async (connection) => {
    if (sets.length) {
      await connection.execute(`UPDATE services SET ${sets.join(', ')} WHERE id = ?`, [
        ...values,
        req.params.id,
      ])
    }
    if (req.body.addOns !== undefined) {
      await replaceAddOns(connection, req.params.id, req.body.addOns)
    }
  })

  await refreshMinPrice(req.user.id)

  const service = await ownedService(req.params.id, req.user.id)
  const [withOns] = await withAddOns([service])
  return success(res, { service: withOns }, 'Service updated successfully')
}

/**
 * POST /api/services/:id/duplicate
 * Copies the service and its add-ons in one transaction. The copy is created
 * as ACTIVE even when duplicating an archived service, since duplicating is
 * how an artist reuses an old service as a starting point.
 */
exports.duplicateService = async (req, res) => {
  const original = await ownedService(req.params.id, req.user.id)
  const newId = uuid()

  // "Bridal Trial" -> "Bridal Trial (Copy)" -> "Bridal Trial (Copy 2)" ...
  const base = `${original.service_name} (Copy`
  const [{ taken }] = await query(
    'SELECT COUNT(*) AS taken FROM services WHERE artist_id = ? AND service_name LIKE ?',
    [req.user.id, `${base}%`]
  )
  const suffix = taken === 0 ? ' (Copy)' : ` (Copy ${taken + 1})`
  const name = `${original.service_name}${suffix}`.slice(0, 160)

  await transaction(async (connection) => {
    await connection.execute(
      `INSERT INTO services
         (id, artist_id, service_name, service_description, service_type,
          price_type, price, currency, duration, duration_minutes, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        newId,
        req.user.id,
        name,
        original.service_description,
        original.service_type,
        original.price_type,
        original.price,
        original.currency,
        original.duration,
        original.duration_minutes,
      ]
    )

    // Copy the add-ons too — a duplicate without them is not a duplicate.
    const addOns = await query('SELECT name, price FROM service_addons WHERE service_id = ?', [
      original.id,
    ])
    for (const addOn of addOns) {
      await connection.execute(
        'INSERT INTO service_addons (id, service_id, name, price) VALUES (?, ?, ?, ?)',
        [uuid(), newId, addOn.name, addOn.price]
      )
    }
  })

  await refreshMinPrice(req.user.id)

  const created = await ownedService(newId, req.user.id)
  const [withOns] = await withAddOns([created])
  return success(res, { service: withOns, id: newId, _id: newId }, 'Service duplicated', 201)
}

/**
 * PATCH /api/services/:id/archive   Body: { archived?: boolean }
 * Archiving hides the service from clients without deleting it, so past
 * bookings and their line items stay intact.
 */
exports.archiveService = async (req, res) => {
  await ownedService(req.params.id, req.user.id)

  const archived = req.body?.archived === undefined ? true : Boolean(req.body.archived)
  await query('UPDATE services SET is_active = ? WHERE id = ?', [archived ? 0 : 1, req.params.id])

  await refreshMinPrice(req.user.id)

  const updated = await ownedService(req.params.id, req.user.id)
  const [withOns] = await withAddOns([updated])
  return success(
    res,
    { service: withOns },
    archived ? 'Service archived. Clients can no longer book it.' : 'Service restored and bookable again.'
  )
}

/** DELETE /api/services/:id */
exports.deleteService = async (req, res) => {
  await ownedService(req.params.id, req.user.id)
  // service_addons cascade; appointment_services keeps its snapshot via ON DELETE SET NULL.
  await query('DELETE FROM services WHERE id = ?', [req.params.id])
  await refreshMinPrice(req.user.id)
  return success(res, {}, 'Service deleted successfully')
}

/** users.min_price drives the "from AED x" badge in the public directory. */
async function refreshMinPrice(artistId) {
  await query(
    `UPDATE users
        SET min_price = (SELECT MIN(price) FROM services WHERE artist_id = ? AND is_active = 1)
      WHERE id = ?`,
    [artistId, artistId]
  )
}

exports.refreshMinPrice = refreshMinPrice
