const express = require('express')
const asyncHandler = require('../utils/asyncHandler')
const { authenticate } = require('../middleware/auth')
const { upload } = require('../middleware/upload')
const controller = require('../controllers/auth.controller')

const router = express.Router()
 
// Public
router.post('/register/client', asyncHandler(controller.registerClient))
router.post('/register/artist', asyncHandler(controller.registerArtist))
router.post('/login', asyncHandler(controller.login))
router.post('/forgot-password', asyncHandler(controller.forgotPassword))
router.post('/reset-password', asyncHandler(controller.resetPassword))

// Authenticated
router.get('/me', authenticate, asyncHandler(controller.getMyProfile))
router.patch('/profile', authenticate, asyncHandler(controller.updateProfile))
router.post('/avatar', authenticate, upload.single('avatar'), asyncHandler(controller.uploadAvatar))
router.delete('/avatar', authenticate, asyncHandler(controller.removeAvatar))
router.patch('/password', authenticate, asyncHandler(controller.updatePassword))
router.post('/logout', authenticate, asyncHandler(controller.logout))

module.exports = router
