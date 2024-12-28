CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    email           CITEXT NOT NULL UNIQUE,
    password_hash   TEXT   NOT NULL,
    is_verified     BOOLEAN NOT NULL DEFAULT false,
    is_disabled     BOOLEAN NOT NULL DEFAULT false,
    terms_accepted  BOOLEAN NOT NULL DEFAULT false,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_verifications (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     BIGINT       NOT NULL REFERENCES users(id),
    activated   BOOLEAN      NOT NULL DEFAULT false,
    expires_at  TIMESTAMPTZ  NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_resets (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     BIGINT       NOT NULL REFERENCES users(id),
    used        BOOLEAN      NOT NULL DEFAULT false,
    expires_at  TIMESTAMPTZ  NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'priority_level') THEN
        CREATE TYPE priority_level AS ENUM ('low', 'medium', 'important');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS tasks (
    id          BIGSERIAL      PRIMARY KEY,
    user_id     BIGINT         NOT NULL REFERENCES users(id),
    title       TEXT           NOT NULL,
    description TEXT,
    priority    priority_level NOT NULL DEFAULT 'low',
    todo_order  INT            NOT NULL DEFAULT 0,

    created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_timestamp() 
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at_trigger ON users;
CREATE TRIGGER users_updated_at_trigger
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS tasks_updated_at_trigger ON tasks;
CREATE TRIGGER tasks_updated_at_trigger
BEFORE UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();
