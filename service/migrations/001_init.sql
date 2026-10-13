CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid,
  scope text NOT NULL CHECK (scope IN ('account', 'user')),
  name text NOT NULL,
  monthly_allowance bigint NOT NULL CHECK (monthly_allowance >= 0),
  max_units_per_request bigint NOT NULL CHECK (max_units_per_request > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (account_id, scope, name)
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  plan_id uuid NOT NULL REFERENCES plans(id),
  api_key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plans
  ADD CONSTRAINT plans_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  external_id text NOT NULL,
  plan_id uuid NOT NULL REFERENCES plans(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);

CREATE TABLE account_monthly_usage (
  account_id uuid NOT NULL REFERENCES accounts(id),
  month date NOT NULL,
  used bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

CREATE TABLE user_monthly_usage (
  user_id uuid NOT NULL REFERENCES users(id),
  month date NOT NULL,
  used bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

CREATE TABLE usage_requests (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  request_id text NOT NULL,
  units bigint NOT NULL,
  accepted boolean NOT NULL,
  rejected_rule text,
  rejected_level text,
  month date NOT NULL,
  applied_limits jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id)
);

CREATE INDEX usage_requests_account_idx ON usage_requests (account_id, id DESC);
CREATE INDEX usage_requests_user_idx ON usage_requests (user_id, id DESC);