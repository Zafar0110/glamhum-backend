 

const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success, paginated } = require('../utils/response')
const { absoluteUpload, serializeService } = require('../utils/serializers')
const { checkSlot } = require('../services/availability.service')
const { addMinutes } = require('../services/appointments.service')
const { looksLikeUuid } = require('../utils/slug')

const VISIBLE = "role = 'artist' AND approval_status = 'approved' AND is_active = 1"

//Shape the public list/detail

function serializePublicArtist(row, portfolioImages = []) {
  return {
    id: row.id,
    _id: row.id,
     
    slug: row.slug || null,
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
    yearsOfExperience: Number(row.years_of_experience || 0),
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

//GET /api/artists

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

  const minRating = parseFloat(req.query.minRating)
  if (!Number.isNaN(minRating) && minRating > 0) {
    where.push('rating >= ?')
    params.push(minRating)
  }

   
  const wantsStudio = req.query.hasStudio === 'true'
  const wantsTravel = req.query.travelsToVenue === 'true'
  if (wantsStudio && !wantsTravel) where.push('has_studio = 1')
  if (wantsTravel && !wantsStudio) where.push('has_studio = 0')

  // "Available on this date" — an artist away on holiday is not.
  const availableOn = (req.query.availableOn || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(availableOn)) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM vacations v
                    WHERE v.artist_id = users.id AND ? BETWEEN v.start_date AND v.end_date)`
    )
    params.push(availableOn)
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

   
  const images = await portfolioImagesFor(rows.map((row) => row.id))

  const artists = rows.map((row) => serializePublicArtist(row, images.get(row.id) || []))

  return paginated(res, { artists }, { total, page, limit })
}

//Portfolio images for many artists at once -> Map<artistId, string

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

 
async function findVisibleArtist(param) {
  const value = String(param || '').trim()
  if (!value) return null

  const column = looksLikeUuid(value) ? 'id' : 'slug'
  return queryOne(`SELECT * FROM users WHERE ${column} = ? AND ${VISIBLE} LIMIT 1`, [value])
}

//GET /api/artists/:artistId

exports.getArtistById = async (req, res) => {
  const artist = await findVisibleArtist(req.params.artistId)
  if (!artist) throw ApiError.notFound('Artist not found or not accepting bookings yet')

  
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate()
  ).padStart(2, '0')}`

  // Independent reads in parallel rather than one after another.
  const [services, images, reviewRows, categories, vacationRows, blockedRows] = await Promise.all([
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
    query(
      `SELECT start_date, end_date FROM vacations
        WHERE artist_id = ? AND end_date >= ?
        ORDER BY start_date ASC LIMIT 12`,
      [artist.id, todayStr]
    ),
    query(
      `SELECT start_date, end_date, start_time, end_time FROM blocked_times
        WHERE artist_id = ? AND end_date >= ?
        ORDER BY start_date ASC, start_time ASC LIMIT 20`,
      [artist.id, todayStr]
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

  
  const toDate = (value) =>
    value instanceof Date
      ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(
          value.getDate()
        ).padStart(2, '0')}`
      : String(value || '').slice(0, 10)

  const unavailability = {
    vacations: vacationRows.map((row) => ({
      startDate: toDate(row.start_date),
      endDate: toDate(row.end_date),
    })),
    blockedTimes: blockedRows.map((row) => ({
      startDate: toDate(row.start_date),
      endDate: toDate(row.end_date),
      startTime: String(row.start_time || '').slice(0, 5),
      endTime: String(row.end_time || '').slice(0, 5),
    })),
  }

  return success(res, {
    artist: payload,
    services: services.map((row) => serializeService(row)),
    reviews,
    unavailability,
  })
}

//GET /api/artists/:artistId/availability

const DAY_SLOTS = ['09:00-11:00', '11:00-13:00', '14:00-16:00', '16:00-18:00', '18:00-20:00']

 
function parseRequestedTime(raw) {
  const value = String(raw || '').trim()
  if (!value) return null

  const [fromPart, toPart] = value.split('-').map((part) => part.trim())
  const normalise = (part) => {
    const match = /^(\d{1,2}):(\d{2})/.exec(part || '')
    if (!match) return null
    const hours = Number(match[1])
    const minutes = Number(match[2])
    if (hours > 23 || minutes > 59) return null
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`
  }

  const startTime = normalise(fromPart)
  if (!startTime) return null

  
  const endTime = normalise(toPart) || addMinutes(startTime, 60)
  return { startTime, endTime }
}

exports.serializePublicArtist = serializePublicArtist
exports.portfolioImagesFor = portfolioImagesFor

exports.checkAvailability = async (req, res) => {
  
  const artist = await findVisibleArtist(req.params.artistId)
  if (!artist) throw ApiError.notFound('Artist not found')

  const date = (req.query.date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw ApiError.validation({ date: 'Provide a date as YYYY-MM-DD' })
  }

  const [appointments, blocked] = await Promise.all([
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
     
    return !busy.some((period) => from < period.to && to > period.from)
  })

   
  const bookedPeriods = [...appointments, ...blocked]
    .map((row) => ({
      startTime: String(row.start_time).slice(0, 5),
      endTime: String(row.end_time || row.start_time).slice(0, 5),
    }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime))

  const requested = parseRequestedTime(req.query.time)

   
  if (requested) {
    const slot = await checkSlot(artist.id, date, requested.startTime, requested.endTime)
    return success(res, {
      available: slot.available,
      reason: slot.reason,
      conflicts: slot.conflicts,
      requestedTime: `${requested.startTime.slice(0, 5)} - ${requested.endTime.slice(0, 5)}`,
      
      timeSlots,
      bookedPeriods,
      date,
    })
  }

  const onVacation = await queryOne(
    'SELECT reason FROM vacations WHERE artist_id = ? AND ? BETWEEN start_date AND end_date LIMIT 1',
    [artist.id, date]
  )
  if (onVacation) {
    return success(res, {
      available: false,
      timeSlots: [],
      bookedPeriods,
      reason: onVacation.reason
        ? `The artist is away on this date (${onVacation.reason})`
        : 'The artist is away on this date',
      date,
    })
  }

  return success(res, { available: timeSlots.length > 0, timeSlots, bookedPeriods, date })
}
