 
CREATE TABLE IF NOT EXISTS users (
  id                CHAR(36)      NOT NULL PRIMARY KEY,
  first_name        VARCHAR(80)   NOT NULL,
  last_name         VARCHAR(80)   NOT NULL,
  username          VARCHAR(60)   NOT NULL,
  email             VARCHAR(190)  NOT NULL,
  password_hash     VARCHAR(255)  NOT NULL,
  phone             VARCHAR(30)   NULL,
  country_code      VARCHAR(8)    NULL,
  avatar            VARCHAR(255)  NULL,
  role              ENUM('client','artist','admin') NOT NULL DEFAULT 'client',
  is_email_verified TINYINT(1)    NOT NULL DEFAULT 0,
  is_phone_verified TINYINT(1)    NOT NULL DEFAULT 0,
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  agreed_to_privacy TINYINT(1)    NOT NULL DEFAULT 0,

  -- artist-only
  city              VARCHAR(120)  NULL,
  address           VARCHAR(255)  NULL,
  latitude          DECIMAL(10,7) NULL,
  longitude         DECIMAL(10,7) NULL,
  has_studio        TINYINT(1)    NULL,
  description       TEXT          NULL,
  specialty         VARCHAR(60)   NULL,
   
  slug              VARCHAR(160)  NULL,
  years_of_experience TINYINT UNSIGNED NOT NULL DEFAULT 0,
  min_price         DECIMAL(10,2) NULL,
  currency          CHAR(3)       NULL DEFAULT 'AED',
  rating            DECIMAL(3,2)  NOT NULL DEFAULT 0.00,
  total_reviews     INT           NOT NULL DEFAULT 0,
  approval_status   ENUM('pending','approved','rejected') NULL,
  rejection_reason  TEXT          NULL,
  approved_by       CHAR(36)      NULL,
  approved_at       DATETIME      NULL,

  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_slug (slug),
  KEY idx_users_role (role),
  KEY idx_users_approval (approval_status),
  KEY idx_users_city (city),
  CONSTRAINT fk_users_approved_by FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

 
CREATE TABLE IF NOT EXISTS services (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  artist_id           CHAR(36)     NOT NULL,
  service_name        VARCHAR(160) NOT NULL,
  service_description TEXT         NULL,
  service_type        VARCHAR(60)  NOT NULL,   
  price_type          VARCHAR(40)  NOT NULL DEFAULT 'fixed',
  price               DECIMAL(10,2) NOT NULL,
  currency            CHAR(3)      NOT NULL DEFAULT 'AED',
  duration            VARCHAR(20)  NOT NULL,  
  duration_minutes    INT          NULL,       
  is_active           TINYINT(1)   NOT NULL DEFAULT 1,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_services_artist (artist_id),
  KEY idx_services_type (service_type),
  CONSTRAINT fk_services_artist FOREIGN KEY (artist_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

 
CREATE TABLE IF NOT EXISTS settings (
  setting_key   VARCHAR(60)  NOT NULL PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_by    CHAR(36)     NULL,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_settings_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_addons (
  id         CHAR(36)      NOT NULL PRIMARY KEY,
  service_id CHAR(36)      NOT NULL,
  name       VARCHAR(160)  NOT NULL,
  price      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  currency   CHAR(3)       NOT NULL DEFAULT 'AED',
  duration   VARCHAR(20)   NULL,
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_addons_service (service_id),
  CONSTRAINT fk_addons_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
 
CREATE TABLE IF NOT EXISTS portfolio_images (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  artist_id  CHAR(36)     NOT NULL,
  image_url  VARCHAR(255) NOT NULL,
  sort_order INT          NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_portfolio_artist (artist_id),
  CONSTRAINT fk_portfolio_artist FOREIGN KEY (artist_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS appointments (
  id                   CHAR(36)      NOT NULL PRIMARY KEY,
  client_id            CHAR(36)      NOT NULL,
  artist_id            CHAR(36)      NOT NULL,
  appointment_date     DATE          NOT NULL,
  start_time           TIME          NOT NULL,
  end_time             TIME          NULL,
  duration_minutes     INT           NULL,
  venue                ENUM('venue','artist_studio','client_venue') NOT NULL DEFAULT 'client_venue',
  venue_name           VARCHAR(160)  NULL,
  venue_street         VARCHAR(255)  NULL,
  venue_city           VARCHAR(120)  NULL,
  venue_state          VARCHAR(120)  NULL,
  status               ENUM('pending','confirmed','completed','cancelled') NOT NULL DEFAULT 'pending',
  currency             CHAR(3)       NOT NULL DEFAULT 'AED',
  total_price          DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  service_fee          DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  payment_method       ENUM('pay_now','pay_at_venue') NOT NULL DEFAULT 'pay_at_venue',
  payment_status       ENUM('unpaid','pending','paid','refunded') NOT NULL DEFAULT 'unpaid',
  payment_intent_id    VARCHAR(120)  NULL, 
  stripe_charge_id     VARCHAR(120)  NULL,
  stripe_transfer_id   VARCHAR(120)  NULL,
  artist_payout_status ENUM('not_applicable','pending','released','refunded') NOT NULL DEFAULT 'not_applicable',
  artist_payout_amount DECIMAL(10,2) NULL,
  notes                TEXT          NULL,
  cancellation_reason  VARCHAR(255)  NULL,
  cancelled_at         DATETIME      NULL,
  created_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_appt_client (client_id),
  KEY idx_appt_artist (artist_id),
  KEY idx_appt_date (appointment_date),
  KEY idx_appt_status (status),
  CONSTRAINT fk_appt_client FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_appt_artist FOREIGN KEY (artist_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

 
CREATE TABLE IF NOT EXISTS appointment_services (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  appointment_id CHAR(36)      NOT NULL,
  service_id     CHAR(36)      NULL,
  service_name   VARCHAR(160)  NOT NULL,
  service_type   VARCHAR(60)   NULL,
  price          DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  KEY idx_appt_services_appt (appointment_id),
  CONSTRAINT fk_appt_services_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT fk_appt_services_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

 
CREATE TABLE IF NOT EXISTS reviews (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  appointment_id  CHAR(36)     NOT NULL,
  client_id       CHAR(36)     NOT NULL,
  artist_id       CHAR(36)     NOT NULL,
  rating          DECIMAL(2,1) NOT NULL,
  professionalism DECIMAL(2,1) NOT NULL DEFAULT 0.0,
  communication   DECIMAL(2,1) NOT NULL DEFAULT 0.0,
  punctuality     DECIMAL(2,1) NOT NULL DEFAULT 0.0,
  value_rating    DECIMAL(2,1) NOT NULL DEFAULT 0.0,
  comment         TEXT         NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_review_appointment (appointment_id),
  KEY idx_reviews_artist (artist_id),
  KEY idx_reviews_client (client_id),
  CONSTRAINT fk_reviews_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_client FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_artist FOREIGN KEY (artist_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
 
CREATE TABLE IF NOT EXISTS messages (
  id             CHAR(36)  NOT NULL PRIMARY KEY,
  appointment_id CHAR(36)  NOT NULL,
  sender_id      CHAR(36)  NOT NULL,
  receiver_id    CHAR(36)  NOT NULL,
  message        TEXT      NOT NULL,
  is_read        TINYINT(1) NOT NULL DEFAULT 0,
  read_at        DATETIME  NULL,
   
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  KEY idx_messages_appt (appointment_id, created_at),
  KEY idx_messages_receiver (receiver_id, is_read),
  CONSTRAINT fk_messages_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_receiver FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

 
CREATE TABLE IF NOT EXISTS blocked_times (
  id         CHAR(36)    NOT NULL PRIMARY KEY,
  artist_id  CHAR(36)    NOT NULL,
  start_date DATE        NOT NULL,
  end_date   DATE        NOT NULL,
  start_time TIME        NOT NULL,
  end_time   TIME        NOT NULL,
  duration   VARCHAR(20) NULL,
  reason     VARCHAR(255) NULL,
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_blocked_artist (artist_id, start_date),
  CONSTRAINT fk_blocked_artist FOREIGN KEY (artist_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vacations (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  artist_id  CHAR(36)     NOT NULL,
  start_date DATE         NOT NULL,
  end_date   DATE         NOT NULL,
  reason     VARCHAR(255) NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_vacations_artist (artist_id, start_date),
  CONSTRAINT fk_vacations_artist FOREIGN KEY (artist_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
 
CREATE TABLE IF NOT EXISTS transactions (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  artist_id      CHAR(36)      NOT NULL, 
  client_id      CHAR(36)      NULL,
  appointment_id CHAR(36)      NULL, 
  type           ENUM('deposit','booking_payment','payout','withdrawal','refund') NOT NULL,
  status         ENUM('pending','in_transit','succeeded','completed','failed') NOT NULL DEFAULT 'pending',
  amount         DECIMAL(10,2) NOT NULL,
  currency       CHAR(3)       NOT NULL DEFAULT 'AED',
  description    VARCHAR(255)  NULL,
  reference      VARCHAR(120)  NULL, 
  bank_details   JSON          NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_txn_artist (artist_id, created_at),
  CONSTRAINT fk_txn_artist FOREIGN KEY (artist_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_txn_client FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_txn_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS withdrawals (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  artist_id      CHAR(36)      NOT NULL,
  amount         DECIMAL(10,2) NOT NULL,
  currency       CHAR(3)       NOT NULL DEFAULT 'AED',
  bank_name      VARCHAR(160)  NULL,
  account_number VARCHAR(64)   NULL,
  iban           VARCHAR(64)   NULL,
  description    VARCHAR(255)  NULL,
  status         ENUM('requested','processing','paid','rejected') NOT NULL DEFAULT 'requested',
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_withdrawals_artist (artist_id),
  CONSTRAINT fk_withdrawals_artist FOREIGN KEY (artist_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stripe_accounts (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  artist_id           CHAR(36)     NOT NULL,
  stripe_account_id   VARCHAR(120) NOT NULL,
  charges_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  payouts_enabled     TINYINT(1)   NOT NULL DEFAULT 0, 
  transfers_enabled   TINYINT(1)   NOT NULL DEFAULT 0,
  onboarding_complete TINYINT(1)   NOT NULL DEFAULT 0,
  requirements_due    JSON         NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_stripe_artist (artist_id),
  CONSTRAINT fk_stripe_artist FOREIGN KEY (artist_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
 
CREATE TABLE IF NOT EXISTS favorites (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  client_id  CHAR(36) NOT NULL,
  artist_id  CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_favorite (client_id, artist_id),
  CONSTRAINT fk_fav_client FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_fav_artist FOREIGN KEY (artist_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
 
CREATE TABLE IF NOT EXISTS otps (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  user_id     CHAR(36)     NULL,
  identifier  VARCHAR(190) NOT NULL,  
  code        VARCHAR(10)  NOT NULL,
  type        ENUM('phone','email') NOT NULL DEFAULT 'phone', 
  delivered_via VARCHAR(10) NOT NULL DEFAULT 'phone',
  purpose     ENUM('signup','forgot_password','update_contact') NOT NULL DEFAULT 'signup',
  expires_at  DATETIME     NOT NULL,
  consumed_at DATETIME     NULL,
  attempts    INT          NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_otps_lookup (identifier, purpose, consumed_at),
  CONSTRAINT fk_otps_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

 
ALTER TABLE users ADD COLUMN IF NOT EXISTS submitted_at DATETIME NULL AFTER approval_status;
