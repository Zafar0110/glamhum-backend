 

const fs = require('fs')
const path = require('path')
const { uploadRoot } = require('../middleware/upload')
const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success, paginated } = require('../utils/response')
const { serializeUser, serializeService } = require('../utils/serializers')
const mail = require('../services/mail.service')
const settingsService = require('../services/settings.service')

const SORT_COLUMNS = {
  createdAt: 'created_at',
  submittedAt: 'submitted_at',
  firstName: 'first_name',
  lastName: 'last_name',
}

 //get admiin apis
exports.getAllArtists = async (req, res) => {
  const { approvalStatus, search, sortBy, sortOrder } = req.query
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
  const offset = (page - 1) * limit

  const where = ["role = 'artist'"]
  const params = []

  if (approvalStatus && approvalStatus !== 'all') {
    where.push('approval_status = ?')
    params.push(approvalStatus)
  }

  if (search && search.trim()) {
    where.push('(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR username LIKE ?)')
    const like = `%${search.trim()}%`
    params.push(like, like, like, like)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`

  // Whitelisted so the sort params can never be injected.
  const column = SORT_COLUMNS[sortBy] || 'created_at'
  const direction = String(sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC'

  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM users ${whereSql}`, params)

  const rows = await query(
    `SELECT * FROM users ${whereSql} ORDER BY ${column} ${direction} LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )

  const artists = rows.map((row) => ({
    ...serializeUser(row),
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    rejectionReason: row.rejection_reason,
  })) 
  return paginated(res, { artists }, { total, page, limit })
}

/** GET /api/admin/artists/:artistId */
exports.getArtistDetails = async (req, res) => {
  const artist = await queryOne("SELECT * FROM users WHERE id = ? AND role = 'artist' LIMIT 1", [
    req.params.artistId,
  ])
  if (!artist) throw ApiError.notFound('Artist not found')

   
  const [services, images, stats] = await Promise.all([
    query('SELECT * FROM services WHERE artist_id = ? AND is_active = 1', [artist.id]),
    query('SELECT id, image_url FROM portfolio_images WHERE artist_id = ? ORDER BY sort_order', [artist.id]),
    queryOne(
      `SELECT
         (SELECT COUNT(*) FROM appointments WHERE artist_id = ?) AS totalAppointments,
         (SELECT COUNT(*) FROM appointments WHERE artist_id = ? AND status = 'completed') AS completedAppointments,
         (SELECT COUNT(*) FROM reviews WHERE artist_id = ?)      AS totalReviews,
         (SELECT COUNT(*) FROM services WHERE artist_id = ? AND is_active = 1) AS totalServices`,
      [artist.id, artist.id, artist.id, artist.id]
    ),
  ])

  return success(res, {
    artist: {
      ...serializeUser(artist),
      submittedAt: artist.submitted_at,
      approvedAt: artist.approved_at,
      rejectionReason: artist.rejection_reason,
      portfolioImages: images.map((row) => row.image_url),
    },
    services: services.map((row) => serializeService(row)),
    portfolioImages: images.map((row) => row.image_url),
    stats: {
      ...stats,
       
      rating: Number(artist.rating || 0),
      averageRating: Number(artist.rating || 0),
      totalReviews: Number(stats.totalReviews || artist.total_reviews || 0),
    },
  })
}

// Shared by approve/reject/status.  
async function loadPendingArtist(artistId) {
  const artist = await queryOne(
    "SELECT id, first_name, email, approval_status, is_active FROM users WHERE id = ? AND role = 'artist' LIMIT 1",
    [artistId]
  )
  if (!artist) throw ApiError.notFound('Artist not found')
  return artist
}

//PATCH /api/admin/artists/:artistId/approve
exports.approveArtist = async (req, res) => {
  const artist = await loadPendingArtist(req.params.artistId)

  if (artist.approval_status === 'approved') {
    throw ApiError.badRequest('This artist is already approved')
  }

  const now = new Date()
  await query(
    `UPDATE users
        SET approval_status = 'approved', approved_by = ?, approved_at = ?,
            rejection_reason = NULL, updated_at = ?
      WHERE id = ?`,
    [req.user.id, now, now, artist.id]
  ) 
  mail.sendArtistApprovedEmail({ to: artist.email, firstName: artist.first_name })

  const updated = await queryOne('SELECT * FROM users WHERE id = ?', [artist.id])
  return success(
    res,
    { artist: { ...serializeUser(updated), approvedAt: now } },
    'Artist approved. They have been emailed.'
  )
}

//PATCH /api/admin/artists/:artistId/reject   Body: { reason }
exports.rejectArtist = async (req, res) => {
  const artist = await loadPendingArtist(req.params.artistId)
  const reason =
    String(req.body?.reason || req.body?.rejectionReason || '').trim() ||
    'Your profile did not meet our listing requirements. Please review your details, services and portfolio images, then submit again.'

  const now = new Date()
  await query(
    `UPDATE users
        SET approval_status = 'rejected', rejection_reason = ?, approved_by = ?, updated_at = ?
      WHERE id = ?`,
    [reason, req.user.id, now, artist.id]
  )

  mail.sendArtistRejectedEmail({ to: artist.email, firstName: artist.first_name, reason })

  const updated = await queryOne('SELECT * FROM users WHERE id = ?', [artist.id])
  return success(
    res,
    { artist: { ...serializeUser(updated), rejectionReason: reason } },
    'Artist rejected. They have been emailed the reason.'
  )
} 
exports.setArtistStatus = async (req, res) => {
  const artist = await loadPendingArtist(req.params.artistId)

  if (typeof req.body?.isActive !== 'boolean') {
    throw ApiError.validation({ isActive: 'isActive must be true or false' })
  }

  const isActive = req.body.isActive ? 1 : 0
  await query('UPDATE users SET is_active = ?, updated_at = NOW() WHERE id = ?', [isActive, artist.id])

  const updated = await queryOne('SELECT * FROM users WHERE id = ?', [artist.id])
  return success(
    res,
    { artist: serializeUser(updated) },
    isActive ? 'Account activated. The artist can sign in again.' : 'Account deactivated. The artist can no longer sign in.'
  )
}

//DELETE /api/admin/artists/:artistId
exports.deleteArtist = async (req, res) => {
  const artist = await queryOne("SELECT * FROM users WHERE id = ? AND role = 'artist' LIMIT 1", [
    req.params.artistId,
  ])
  if (!artist) throw ApiError.notFound('Artist not found')

  const [{ live }] = await query(
    `SELECT COUNT(*) AS live FROM appointments
      WHERE artist_id = ? AND status IN ('pending','confirmed')`,
    [artist.id]
  )

  if (live > 0) {
    throw ApiError.badRequest(
      `This artist has ${live} active booking(s). Cancel or complete them before deleting, or deactivate the account instead.`
    )
  }

  const images = await query('SELECT image_url FROM portfolio_images WHERE artist_id = ?', [artist.id])

  await query('DELETE FROM users WHERE id = ?', [artist.id])
  for (const image of images) {
    fs.promises.unlink(path.join(uploadRoot, path.basename(image.image_url))).catch(() => {})
  }

  return success(res, { id: artist.id }, 'Artist deleted permanently')
}

/** GET /api/admin/stats */
exports.getDashboardStats = async (req, res) => {
  
  const stats = await queryOne(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'artist')                              AS artistsTotal,
      (SELECT COUNT(*) FROM users WHERE role = 'artist' AND approval_status='pending')  AS artistsPending,
      (SELECT COUNT(*) FROM users WHERE role = 'artist' AND approval_status='approved') AS artistsApproved,
      (SELECT COUNT(*) FROM users WHERE role = 'artist' AND approval_status='rejected') AS artistsRejected,
      (SELECT COUNT(*) FROM users WHERE role = 'client')                              AS clientsTotal,
      (SELECT COUNT(*) FROM appointments)                                             AS appointmentsTotal,
      (SELECT COUNT(*) FROM services WHERE is_active = 1)                             AS servicesTotal,
      (SELECT COALESCE(SUM(total_price),0) FROM appointments WHERE payment_status='paid') AS totalRevenue
  `)

  return success(res, {
    artists: {
      total: Number(stats.artistsTotal),
      pending: Number(stats.artistsPending),
      approved: Number(stats.artistsApproved),
      rejected: Number(stats.artistsRejected),
    },
    clients: { total: Number(stats.clientsTotal) },
    appointments: { total: Number(stats.appointmentsTotal) },
    services: { total: Number(stats.servicesTotal) },
    totalRevenue: Number(stats.totalRevenue),
  })
} 
// GET /api/admin/settings  
exports.getSettings = async (req, res) => {
  const [settings, meta] = await Promise.all([
    settingsService.getSettings(),
    settingsService.getMetadata(),
  ])

  return success(res, { settings, lastChange: meta })
}

 //PATCH /api/admin/settings
exports.updateSettings = async (req, res) => {
  const { errors, settings } = await settingsService.updateSettings(req.body || {}, req.user.id)
  if (errors) throw ApiError.validation(errors)

  const meta = await settingsService.getMetadata()
  return success(res, { settings, lastChange: meta }, 'Settings saved')
}
