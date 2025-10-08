-- Importação de membros existentes

-- Fatos da Bolsa Suporte
INSERT INTO subscribers (name, email, phone, plan, status) VALUES 
  ('Fatos da Bolsa Suporte', 'suportefatosdabolsa@telegram.user', '00000000000', 'Projeto Renda Passiva', 'active')
ON CONFLICT (email) DO NOTHING;

INSERT INTO authorized_users (telegram_id, subscriber_id, authorized, authorized_at) 
SELECT '6221220051', id, true, NOW() FROM subscribers WHERE email = 'suportefatosdabolsa@telegram.user'
ON CONFLICT (telegram_id) DO NOTHING;

-- Gabrine Acoes americanas
INSERT INTO subscribers (name, email, phone, plan, status) VALUES 
  ('Gabrine Acoes americanas', 'sem-email@telegram.user', '00000000000', 'CF VIP - FATOS DA BOLSA 1', 'active')
ON CONFLICT (email) DO NOTHING;

INSERT INTO authorized_users (telegram_id, subscriber_id, authorized, authorized_at) 
SELECT '1419540188', id, true, NOW() FROM subscribers WHERE email = 'sem-email@telegram.user'
ON CONFLICT (telegram_id) DO NOTHING;

-- Davi Souza
INSERT INTO subscribers (name, email, phone, plan, status) VALUES 
  ('Davi Souza', 'davicnpi@telegram.user', '00000000000', 'Projeto Renda Passiva', 'active')
ON CONFLICT (email) DO NOTHING;

INSERT INTO authorized_users (telegram_id, subscriber_id, authorized, authorized_at) 
SELECT '909309945', id, true, NOW() FROM subscribers WHERE email = 'davicnpi@telegram.user'
ON CONFLICT (telegram_id) DO NOTHING;

-- Jacqueline Dias
INSERT INTO subscribers (name, email, phone, plan, status) VALUES 
  ('Jacqueline Dias', 'Jacqueline_dias@telegram.user', '00000000000', 'Projeto Renda Passiva', 'active')
ON CONFLICT (email) DO NOTHING;

INSERT INTO authorized_users (telegram_id, subscriber_id, authorized, authorized_at) 
SELECT '1839742847', id, true, NOW() FROM subscribers WHERE email = 'Jacqueline_dias@telegram.user'
ON CONFLICT (telegram_id) DO NOTHING;

-- Marcos Schilling
INSERT INTO subscribers (name, email, phone, plan, status) VALUES 
  ('Marcos Schilling', 'Marcos_Schilling@telegram.user', '00000000000', 'CF VIP - FATOS DA BOLSA 1', 'active')
ON CONFLICT (email) DO NOTHING;

INSERT INTO authorized_users (telegram_id, subscriber_id, authorized, authorized_at) 
SELECT '575539491', id, true, NOW() FROM subscribers WHERE email = 'Marcos_Schilling@telegram.user'
ON CONFLICT (telegram_id) DO NOTHING;

