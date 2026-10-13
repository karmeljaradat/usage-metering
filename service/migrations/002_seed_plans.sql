INSERT INTO plans (account_id, scope, name, monthly_allowance, max_units_per_request) VALUES
  (NULL, 'account', 'Starter', 10000,  100),
  (NULL, 'account', 'Pro',     100000, 1000),
  (NULL, 'user',    'Basic',   1000,   20),
  (NULL, 'user',    'Premium', 10000,  200)
ON CONFLICT DO NOTHING;