 

const fs = require('fs')
const path = require('path')
const { v4: uuid } = require('uuid')
const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success } = require('../utils/response')
const { uploadRoot, publicUrl } = require('../middleware/upload')

const MAX_IMAGES = 20

//GET /api/portfolio/:artistId — public
exports.getPortfolioImages = async (req, res) => {
  const rows = await query(
    'SELECT id, image_url FROM portfolio_images WHERE artist_id = ? ORDER BY sort_order ASC, created_at ASC',
    [req.params.artistId]
  )

   
  return success(res, {
    images: rows.map((row) => ({ _id: row.id, id: row.id, url: row.image_url, imageUrl: row.image_url })),
    portfolioImages: rows.map((row) => row.image_url),
  })
}

 //GET /api/portfolio
exports.getMyPortfolio = async (req, res) => {
  req.params.artistId = req.user.id
  return exports.getPortfolioImages(req, res)
}

//POST /api/portfolio
exports.uploadPortfolioImages = async (req, res) => {
  const files = req.files || []
  if (!files.length) throw ApiError.validation({ images: 'Please choose at least one image' })

  const [{ count }] = await query(
    'SELECT COUNT(*) AS count FROM portfolio_images WHERE artist_id = ?',
    [req.user.id]
  )

  if (count + files.length > MAX_IMAGES) {
    // Don't keep files we are about to reject.
    files.forEach((file) => fs.promises.unlink(file.path).catch(() => {}))
    throw ApiError.validation({
      images: `You can have at most ${MAX_IMAGES} portfolio images (${count} already uploaded)`,
    })
  }

  const values = []
  const placeholders = []
  files.forEach((file, index) => {
    const url = publicUrl(file.filename)
    placeholders.push('(?, ?, ?, ?)')
    values.push(uuid(), req.user.id, url, count + index)
  })

  // One multi-row INSERT rather than one per file.
  await query(
    `INSERT INTO portfolio_images (id, artist_id, image_url, sort_order) VALUES ${placeholders.join(', ')}`,
    values
  )

  const rows = await query(
    'SELECT id, image_url FROM portfolio_images WHERE artist_id = ? ORDER BY sort_order ASC, created_at ASC',
    [req.user.id]
  )

  return success(
    res,
    {
      images: rows.map((row) => row.image_url),
      uploaded: files.map((file) => publicUrl(file.filename)),
      portfolioImages: rows.map((row) => row.image_url),
    },
    'Images uploaded successfully',
    201
  )
}

//DELETE /api/portfolio
exports.deletePortfolioImage = async (req, res) => {
  const { imageUrl, id } = req.body || {}
  if (!imageUrl && !id) throw ApiError.validation({ imageUrl: 'Image reference is required' })

  const row = id
    ? await queryOne('SELECT * FROM portfolio_images WHERE id = ? LIMIT 1', [id])
    : await queryOne('SELECT * FROM portfolio_images WHERE artist_id = ? AND image_url = ? LIMIT 1', [
        req.user.id,
        imageUrl,
      ])

  if (!row) throw ApiError.notFound('Image not found')
  if (row.artist_id !== req.user.id) throw ApiError.forbidden('This image belongs to another artist')

  await query('DELETE FROM portfolio_images WHERE id = ?', [row.id]) 
  const filename = path.basename(row.image_url)
  fs.promises.unlink(path.join(uploadRoot, filename)).catch(() => {})

  return success(res, {}, 'Image deleted successfully')
}
