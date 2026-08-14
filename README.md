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
| `npm run mail:preview` | write `preview-email.html` to check the template design |
| `npm run mail:test -- you@example.com` | verify SMTP and send a real test email |

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
| POST | `/api/auth/forgot-password` | emails a reset code |
| POST | `/api/auth/reset-password` | verifies code, sets password |
| POST | `/api/otp/send-email` | send/re-send the sign-up code |
| POST | `/api/otp/verify-email` | verify code → returns `{ user, token }` |
| POST | `/api/otp/resend` | `purpose: signup \| forgot_password` |
| POST | `/api/otp/send-phone` | 501 until SMS is enabled |
| GET | `/api/stripe/config` | |

Registered but returning 501 — grouped under
`/api/artists` (public directory), `/api/artist` (artist dashboard),
`/api/client`, `/api/services`, `/api/portfolio`, `/api/admin`,
`/api/stripe/webhook`. Open the matching file in `src/routes/` to see the exact
list; each stub is labelled with the frontend function it serves, e.g.
`artistAPI.getAllAppointments`.

## OTP (email)

Sign-up verification goes by **email**. `POST /api/auth/register/*` creates the
account and immediately issues a **4-digit** code (`OTP_LENGTH`); the user
confirms it at `POST /api/otp/verify-email`, which marks the email verified and
returns a fresh token.

Codes expire after `OTP_EXPIRES_MINUTES` (10), allow 5 wrong attempts, and
issuing a new one voids the previous. Phone/SMS is parked — `deliverSms()` in
`src/services/otp.service.js` is where Twilio slots in.

> Changing `OTP_LENGTH` means changing `NEXT_PUBLIC_OTP_LENGTH` in
> `frontend/.env.local` too, or the API will reject what the form sends.

**Abandoned sign-ups.** An email is only claimed once it has been confirmed.
If someone registers and never enters the code, registering again with that
same address overwrites the unverified row and sends a fresh code, instead of
answering "already registered" forever. Once `is_email_verified = 1`, the
address is locked to that account. Usernames belonging to *other* accounts are
always rejected.

### SMTP configuration

Both naming styles are read, so a Laravel-style `.env` works as-is:

| Purpose | Either | Or |
|---|---|---|
| Host | `SMTP_HOST` | `MAIL_HOST` |
| Port | `SMTP_PORT` | `MAIL_PORT` |
| TLS | `SMTP_SECURE` | `MAIL_ENCRYPTION` (`ssl` → secure, `tls` → STARTTLS) |
| Username | `SMTP_USER` | `MAIL_USERNAME` |
| Password | `SMTP_PASSWORD` | `MAIL_PASSWORD` |
| From | `MAIL_FROM` | `MAIL_FROM_ADDRESS` + `MAIL_FROM_NAME` |

Port 465 is implicit TLS (`secure: true`); 587 uses STARTTLS (`secure: false`) —
forcing `secure: true` on 587 hangs the connection.

With no host configured the code is only printed to the server console, and
while `OTP_DEBUG_RETURN=true` it also comes back as `data.debugCode`.
**Set `OTP_DEBUG_RETURN=false` in production.**

Check delivery before blaming the sign-up flow:

```bash
npm run mail:test -- you@example.com
```

### Email template

`src/services/emailTemplates.js` — table-based, fully inlined styles (Gmail and
Outlook strip `<style>` blocks), site palette (navy `#091E4A`, pink `#d4a5a5`,
cream `#fdf5f3`, peach `#fce8e2`), serif headings with the pink underline, and
one peach tile per code digit. The logo is attached inline as `cid:glamhub-logo`
from `src/assets/logo.png`, so it renders even when the client blocks remote
images. Every email also carries a plain-text alternative, which helps it stay
out of spam.

## Performance

The frontend calls these on every page, so they are written to stay fast on
shared hosting:

- **One pooled MySQL connection set**, created once at boot — never per request
- **Nodemailer transporter is created once and pooled**, and mail is sent with
  `setImmediate` *after* the response — SMTP latency never touches API time
- **gzip on responses > 1KB**, ETag generation off
- Lookups use unique indexes; login picks `email` **or** `username` explicitly
  so MySQL uses one index instead of merging two
- Registration builds its response from the inserted values instead of
  re-selecting the row

Measured locally: `/api/health` 8ms, `/api/otp/verify-email` 6ms,
`/api/auth/login` ~175ms — of which ~170ms is deliberate bcrypt work
(`BCRYPT_ROUNDS=10`). Everything non-hashing is single-digit milliseconds.

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
