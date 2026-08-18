 

const fs = require('fs')
const path = require('path')
const multer = require('multer')
const { v4: uuid } = require('uuid')
const env = require('../config/env')
const ApiError = require('../utils/ApiError')

const uploadRoot = path.isAbsolute(env.upload.dir)
  ? env.upload.dir
  : path.join(__dirname, '..', '..', env.upload.dir)

fs.mkdirSync(uploadRoot, { recursive: true })

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadRoot)
  },
  filename(req, file, cb) {
    cb(null, `${Date.now()}-${uuid().slice(0, 8)}${path.extname(file.originalname).toLowerCase()}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: env.upload.maxBytes },
  fileFilter(req, file, cb) {
    if (!ALLOWED.includes(file.mimetype)) {
      return cb(ApiError.badRequest('Only JPG, PNG, WEBP and GIF images are allowed'))
    }
    cb(null, true)
  },
})

//Public URL for a stored file
const publicUrl = (filename) => `/uploads/${filename}`

module.exports = { upload, uploadRoot, publicUrl }
