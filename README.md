# GlamHub Backend — Express + MySQL

REST API + Socket.IO server for the GlamHub frontend (`../frontend`).

**Status:** infrastructure is complete and running. Auth and OTP are implemented;
the remaining endpoints are registered but return `501 Not implemented` until
their controllers are written (see [Roadmap](#roadmap)).

---

## Requirements

- Node.js 18+ (tested on 24)
- MySQL 8+ (or MariaDB 10.4+ — XAMPP works)

## Setup

```bash
npm install
cp .env.example .env      # then edit DB_USER / DB_PASSWORD / JWT_SECRET
npm run db:migrate        # creates the `glamhub` database + all tables
npm run db:seed           # optional: admin / artist / client test accounts
npm run dev               # http://localhost:5000
```

Check it is alive:

```bash
curl http://localhost:5000/api/health
```

Seeded accounts (password `Password@123`): `admin@glamhub.test`,
`artist@glamhub.test`, `client@glamhub.test`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | nodemon, reloads on change |
| `npm start` | production start |
| `npm run db:migrate` | create database + apply `src/db/schema.sql` (safe to re-run) |
| `npm run db:migrate -- --fresh` | **drops** the database, then re-applies the schema |
| `npm run db:seed` | insert the three test accounts |
| `npm run db:reset` | fresh migrate + seed |

## Layout

```
src/
├── server.js              entry point: HTTP server + Socket.IO + graceful shutdown
├── app.js                 express app: helmet, cors, json, rate limit, /uploads, routes
├── config/
│   ├── env.js             every env var is read here and nowhere else
│   └── db.js              mysql2 pool + query / queryOne / transaction / testConnection
├── middleware/
│   ├── auth.js            authenticate, authorize(...roles), optionalAuth
│   ├── errorHandler.js    404 + central error -> failure envelope
│   └── upload.js          multer disk storage for avatars / portfolio images
├── utils/
│   ├── response.js        success / paginated / failure envelopes
│   ├── ApiError.js        throwable HTTP errors
│   ├── serializers.js     DB row -> the exact JSON shape the frontend expects
│   ├── jwt.js             sign / verify
│   ├── asyncHandler.js    async route wrapper
│   └── notImplemented.js  placeholder for unbuilt endpoints
├── routes/                one file per API group, all mounted in routes/index.js
├── controllers/           auth + otp implemented
├── services/              otp.service.js (code issue / verify)
├── sockets/index.js       JWT-authenticated Socket.IO, emits `new_message`
└── db/
    ├── schema.sql         full MySQL schema
    ├── migrate.js         applies the schema
    └── seed.js            test accounts
```

## Response format

The frontend parses every response as this envelope — keep it consistent:

```jsonc
// success
{ "success": true, "message": "OK", "data": { "artists": [] }, "total": 42, "page": 1, "pages": 4 }

// error
{ "success": false, "message": "Validation failed", "errors": { "email": "Enter a valid email address" } }
```

Objects are serialized with **both `id` and `_id`** plus a computed `fullName`
(the frontend came from a Mongo API and still reads those keys). `src/utils/serializers.js`
handles this — use it rather than returning raw rows.

## Auth

`POST /api/auth/login` returns a JWT. The frontend stores it in `localStorage`
under `auth_token`; send it back as `Authorization: Bearer <token>`.
`authenticate` loads the full user row onto `req.user`; `authorize('artist')`
restricts by role.

## Endpoints

Implemented:

| Method | Path | |
|---|---|---|
| GET | `/api/health` | liveness + DB ping |
| POST | `/api/auth/register/client` | |
| POST | `/api/auth/register/artist` | |
| POST | `/api/auth/login` | accepts `email` or `username` |
| GET | `/api/auth/me` | auth |
| PATCH | `/api/auth/profile` | auth |
| PATCH | `/api/auth/password` | auth |
| POST | `/api/auth/logout` | auth |
| POST | `/api/auth/forgot-password` | issues an OTP |
| POST | `/api/auth/reset-password` | verifies OTP, sets password |
| POST | `/api/otp/send` `/verify` `/resend` | |
| GET | `/api/stripe/config` | |

Registered but returning 501 — grouped under
`/api/artists` (public directory), `/api/artist` (artist dashboard),
`/api/client`, `/api/services`, `/api/portfolio`, `/api/admin`,
`/api/stripe/webhook`. Open the matching file in `src/routes/` to see the exact
list; each stub is labelled with the frontend function it serves, e.g.
`artistAPI.getAllAppointments`.

## OTP

No SMS/email provider is wired up. Codes are stored in the `otps` table and
logged to the console; with `OTP_DEBUG_RETURN=true` (development only) the code
also comes back in the response as `debugCode`. Plug a provider into
`deliver()` in `src/services/otp.service.js`.

## Real-time chat

Socket.IO authenticates with the same JWT (`socket.handshake.auth.token`) and
joins each user to a room named after their user id. After saving a message,
call `sockets.emitNewMessage(serializedMessage)` — that emits `new_message` to
the receiver, which is exactly what `frontend/docs/BACKEND_CHAT_REQUIREMENTS.md`
asks for.

## Connecting the frontend

The frontend currently runs on mock data: `frontend/lib/api.ts` returns
in-memory objects from `lib/dummyData.ts` and never makes an HTTP request.
When endpoints are ready, point it here — set `NEXT_PUBLIC_API_URL=http://localhost:5000/api`
in `frontend/.env.local` and replace the mock bodies in `lib/api.ts` with axios
calls. The exported function names and signatures already match this API, so no
page or component needs to change.

## Roadmap

1. Public artists directory (`/api/artists`) — list with filters/sort/pagination, detail, availability
2. Services CRUD + portfolio uploads
3. Bookings: create, list, cancel (client) and schedule/blocked time/vacations (artist)
4. Messages + Socket.IO wiring
5. Reviews (and recomputing `users.rating` / `total_reviews`)
6. Admin approvals + stats
7. Stripe: PaymentIntents, Connect onboarding, webhooks, payouts/withdrawals
