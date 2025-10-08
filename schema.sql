-- Tabela de administradores do painel
CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);

-- Tabela de assinantes (seus clientes)
CREATE TABLE IF NOT EXISTS subscribers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    phone VARCHAR(20) NOT NULL,
    plan VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_subscribers_email ON subscribers(email);
CREATE INDEX idx_subscribers_phone ON subscribers(phone);
CREATE INDEX idx_subscribers_status ON subscribers(status);

-- Tabela de usuários autorizados (vincula Telegram ID com assinante)
CREATE TABLE IF NOT EXISTS authorized_users (
    id SERIAL PRIMARY KEY,
    telegram_id VARCHAR(50) NOT NULL UNIQUE,
    subscriber_id INTEGER NOT NULL,
    authorized BOOLEAN DEFAULT true,
    authorized_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_access TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);

CREATE INDEX idx_authorized_telegram_id ON authorized_users(telegram_id);
CREATE INDEX idx_authorized_authorized ON authorized_users(authorized);

-- Tabela de canais
CREATE TABLE IF NOT EXISTS channels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    link VARCHAR(500) NOT NULL,
    description TEXT,
    plan VARCHAR(50) NOT NULL,
    order_index INTEGER DEFAULT 0,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_channels_plan ON channels(plan);
CREATE INDEX idx_channels_active ON channels(active);

-- Tabela de logs de autorização
CREATE TABLE IF NOT EXISTS authorization_logs (
    id SERIAL PRIMARY KEY,
    telegram_id VARCHAR(50) NOT NULL,
    subscriber_id INTEGER,
    action VARCHAR(20) NOT NULL CHECK (action IN ('authorized', 'revoked', 'access')),
    ip_address VARCHAR(45),
    user_agent TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE SET NULL
);

CREATE INDEX idx_logs_telegram_id ON authorization_logs(telegram_id);
CREATE INDEX idx_logs_action ON authorization_logs(action);
CREATE INDEX idx_logs_timestamp ON authorization_logs(timestamp);

-- Inserção de dados de exemplo
INSERT INTO subscribers (name, email, phone, plan, status) VALUES
('João Silva', 'joao@email.com', '11999999999', 'basico', 'active'),
('Maria Santos', 'maria@email.com', '11988888888', 'premium', 'active'),
('Pedro Oliveira', 'pedro@email.com', '11977777777', 'vip', 'active');

-- Exemplo de canais (SUBSTITUA pelos seus links reais do Telegram!)
INSERT INTO channels (name, link, description, plan, order_index, active) VALUES
('Canal de Anúncios', 'https://t.me/+XXXXXXXXXXXXX', 'Novidades e avisos gerais', 'all', 1, true),
('Análises Diárias', 'https://t.me/+YYYYYYYYYYYYYY', 'Análises do mercado', 'basico', 2, true),
('Sinais Premium', 'https://t.me/+AAAAAAAAAAAAAA', 'Sinais em tempo real', 'premium', 3, true),
('Sala VIP Exclusiva', 'https://t.me/+DDDDDDDDDDDDDD', 'Acesso total aos traders', 'vip', 4, true);