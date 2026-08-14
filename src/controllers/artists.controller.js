// Public artist directory — powers the home page "Featured Artists" strip,
// /explore (search + filters) and /explore/[artistId] (profile detail).
//
// Only APPROVED, ACTIVE artists are ever visible here.

const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success, paginated } = require('../utils/response')
const { absoluteUpload, serializeService } = require('../utils/serializers')

const VISIBLE = "role = 'artist' AND approval_status = 'approved' AND is_active = 1"

/** Shape the public list/detail screens expect (see lib/utils/artistMapper.ts). */
function serializePublicArtist(row, portfolioImages = []) {
  return {
    id: row.id,
    _id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: [row.first_name, row.last_name].filter(Boolean).join(' '),
    username: row.username,
    avatar: absoluteUpload(row.avatar || ''),
    city: row.city || '',
    address: row.address || '',
    hasStudio: Boolean(row.has_studio),
    description: row.description || '',
    specialty: row.specialty || '',
    rating: Number(row.rating || 0),
    totalReviews: Number(row.total_reviews || 0),
    pricing: {
      minPrice: Number(row.min_price || 0),
      currency: row.currency || 'AED',
    },
    portfolioImages,
    approvalStatus: row.approval_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * GET /api/artists
 * ?page &limit &city &serviceType &minPrice &maxPrice &search &sortBy
 * sortBy: rating (default) | price | newest
 */
exports.getArtists = async (req, res) => {
  const { city, serviceType, search, sortBy } = req.query
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12))
  const offset = (page - 1) * limit

  const where = [VISIBLE]
  const params = []

  if (city && city.trim()) {
    where.push('city LIKE ?')
    params.push(`%${city.trim()}%`)
  }

  if (search && search.trim()) {
    where.push('(first_name LIKE ? OR last_name LIKE ? OR description LIKE ? OR city LIKE ?)')
    const like = `%${search.trim()}%`
    params.push(like, like, like, like)
  }

  // Matches the artist's headline specialty OR any service they actually offer.
  if (serviceType && serviceType.trim()) {
    where.push(
      `(LOWER(specialty) = LOWER(?)
        OR EXISTS (SELECT 1 FROM services s
                    WHERE s.artist_id = users.id AND s.is_active = 1
                      AND LOWER(s.service_type) = LOWER(?)))`
    )
    params.push(serviceType.trim(), serviceType.trim())
  }

  const minPrice = parseFloat(req.query.minPrice)
  const maxPrice = parseFloat(req.query.maxPrice)
  if (!Number.isNaN(minPrice) && minPrice > 0) {
    where.push('min_price >= ?')
    params.push(minPrice)
  }
  if (!Number.isNaN(maxPrice) && maxPrice > 0) {
    where.push('min_price <= ?')
    params.push(maxPrice)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`

  // Whitelisted so sortBy can never be injected.
  const orderBy =
    sortBy === 'price'
      ? 'min_price IS NULL, min_price ASC'
      : sortBy === 'newest'
        ? 'created_at DESC'
        : 'rating DESC, total_reviews DESC'

  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM users ${whereSql}`, params)

  const rows = await query(
    `SELECT * FROM users ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )

  // SPEED: one query for every artist's images instead of one per artist.
  const images = await portfolioImagesFor(rows.map((row) => row.id))

  const artists = rows.map((row) => serializePublicArtist(row, images.get(row.id) || []))

  return paginated(res, { artists }, { total, page, limit })
}

/** Portfolio images for many artists at once -> Map<artistId, string[]>. */
async function portfolioImagesFor(artistIds) {
  const map = new Map()
  if (!artistIds.length) return map

  const placeholders = artistIds.map(() => '?').join(',')
  const rows = await query(
    `SELECT artist_id, image_url FROM portfolio_images
      WHERE artist_id IN (${placeholders})
      ORDER BY sort_order ASC, created_at ASC`,
    artistIds
  )

  for (const row of rows) {
    if (!map.has(row.artist_id)) map.set(row.artist_id, [])
    map.get(row.artist_id).push(absoluteUpload(row.image_url))
  }

  return map
}

/**
 * GET /api/artists/:artistId
 * -> { artist (with stats + portfolioImages), services, reviews }
 */
exports.getArtistById = async (req, res) => {
  const artist = await queryOne(`SELECT * FROM users WHERE id = ? AND ${VISIBLE} LIMIT 1`, [
    req.params.artistId,
  ])
  if (!artist) throw ApiError.notFound('Artist not found or not accepting bookings yet')

  // Three independent reads in parallel rather than one after another.
  const [services, images, reviewRows, categories] = await Promise.all([
    query('SELECT * FROM services WHERE artist_id = ? AND is_active = 1 ORDER BY price ASC', [artist.id]),
    query('SELECT image_url FROM portfolio_images WHERE artist_id = ? ORDER BY sort_order ASC, created_at ASC', [artist.id]),
    query(
      `SELECT r.rating, r.comment, r.created_at,
              u.first_name, u.last_name, u.avatar
         FROM reviews r
         JOIN users u ON u.id = r.client_id
        WHERE r.artist_id = ?
        ORDER BY r.created_at DESC
        LIMIT 50`,
      [artist.id]
    ),
    queryOne(
      `SELECT AVG(professionalism) AS professionalism, AVG(punctuality) AS punctuality,
              AVG(communication) AS communication, AVG(value_rating) AS value,
              COUNT(*) AS total, AVG(rating) AS overall
         FROM reviews WHERE artist_id = ?`,
      [artist.id]
    ),
  ])

  const round = (value) => Math.round((Number(value) || 0) * 10) / 10

  const payload = serializePublicArtist(artist, images.map((row) => absoluteUpload(row.image_url)))

  // The detail mapper reads artist.stats.{rating,totalReviews,categories}.
  payload.stats = {
    rating: round(categories.overall || artist.rating),
    totalReviews: Number(categories.total || 0),
    categories: {
      professionalism: round(categories.professionalism),
      punctuality: round(categories.punctuality),
      communication: round(categories.communication),
      value: round(categories.value),
    },
  }

  const reviews = reviewRows.map((row) => ({
    clientName: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Anonymous',
    clientAvatar: absoluteUpload(row.avatar || ''),
    rating: Number(row.rating),
    comment: row.comment || '',
    createdAt: row.created_at,
  }))

  return success(res, {
    artist: payload,
    services: services.map((row) => serializeService(row)),
    reviews,
  })
}

/**
 * GET /api/artists/:artistId/availability?date=YYYY-MM-DD
 * Returns the slots left after existing appointments, blocked time and
 * vacations are removed.
 */
const DAY_SLOTS = ['09:00-11:00', '11:00-13:00', '14:00-16:00', '16:00-18:00', '18:00-20:00']

exports.checkAvailability = async (req, res) => {
  const artist = await queryOne(`SELECT id FROM users WHERE id = ? AND ${VISIBLE} LIMIT 1`, [
    req.params.artistId,
  ])
  if (!artist) throw ApiError.notFound('Artist not found')

  const date = (req.query.date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw ApiError.validation({ date: 'Provide a date as YYYY-MM-DD' })
  }

  const [onVacation, appointments, blocked] = await Promise.all([
    queryOne(
      'SELECT id FROM vacations WHERE artist_id = ? AND ? BETWEEN start_date AND end_date LIMIT 1',
      [artist.id, date]
    ),
    query(
      `SELECT start_time, end_time FROM appointments
        WHERE artist_id = ? AND appointment_date = ? AND status IN ('pending','confirmed')`,
      [artist.id, date]
    ),
    query(
      `SELECT start_time, end_time FROM blocked_times
        WHERE artist_id = ? AND ? BETWEEN start_date AND end_date`,
      [artist.id, date]
    ),
  ])

  if (onVacation) {
    return success(res, { available: false, timeSlots: [], reason: 'The artist is away on this date' })
  }

  const toMinutes = (value) => {
    const [hours, minutes] = String(value).split(':').map(Number)
    return hours * 60 + (minutes || 0)
  }

  const busy = [...appointments, ...blocked].map((row) => ({
    from: toMinutes(row.start_time),
    to: toMinutes(row.end_time || row.start_time),
  }))

  const timeSlots = DAY_SLOTS.filter((slot) => {
    const [from, to] = slot.split('-').map(toMinutes)
    // Keep the slot only if it overlaps nothing already booked.
    return !busy.some((period) => from < period.to && to > period.from)
  })

  return success(res, { available: timeSlots.length > 0, timeSlots, date })
}
