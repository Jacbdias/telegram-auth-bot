const { Pool } = require('pg');

// Configuração do pool de conexões PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function ensureSchema() {
  if (!process.env.DATABASE_URL) {
    return;
  }

  try {
    await pool.query(
      `ALTER TABLE channels
       ADD COLUMN IF NOT EXISTS chat_id VARCHAR(50)`
    );

    await pool.query(
      `ALTER TABLE channels
       ADD COLUMN IF NOT EXISTS creates_join_request BOOLEAN NOT NULL DEFAULT false`
    );

    await pool.query(
      `ALTER TABLE subscribers
       ADD COLUMN IF NOT EXISTS origin VARCHAR(20) DEFAULT 'manual'`
    );

    await pool.query(
      `ALTER TABLE subscribers
       ALTER COLUMN origin SET DEFAULT 'manual'`
    );

    await pool.query(
      `UPDATE subscribers
       SET origin = 'manual'
       WHERE origin IS NULL`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS user_invite_links (
         id SERIAL PRIMARY KEY,
         telegram_id VARCHAR(50) NOT NULL,
         channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
         invite_link TEXT NOT NULL,
         expire_at TIMESTAMP,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         revoked_at TIMESTAMP
       )`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_user_invite_links_telegram
       ON user_invite_links(telegram_id)`
    );

    const requiredChannels = [
      {
        name: 'Mentoria Renda Turbinada',
        chatId: '-1003268530938',
        description: 'Canal da Mentoria Renda Turbinada',
        plan: 'Mentoria Renda Turbinada',
        orderIndex: 0
      }
    ];

    for (const channel of requiredChannels) {
      await pool.query(
        `INSERT INTO channels (name, chat_id, description, plan, order_index, active, creates_join_request)
         SELECT $1, $2, $3, $4, $5, true, false
         WHERE NOT EXISTS (
           SELECT 1 FROM channels WHERE chat_id = $2 OR (plan = $4 AND name = $1)
         )`,
        [
          channel.name,
          channel.chatId,
          channel.description,
          channel.plan,
          channel.orderIndex
        ]
      );
    }
  } catch (error) {
    console.error('Erro ao garantir esquema inicial:', error);
    throw error;
  }
}

const schemaReady = ensureSchema().catch((error) => {
  console.error('Falha ao aplicar migrações iniciais:', error);
  throw error;
});

// Helper para normalizar telefone
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

// Helper para normalizar email
function normalizeEmail(email) {
  if (!email) return '';
  return email.trim().toLowerCase();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============== ADMIN USERS ==============

// Busca admin por username
async function getAdminUserByUsername(username) {
  try {
    const result = await pool.query(
      `SELECT id, username, password_hash, created_at, updated_at, last_login
       FROM admin_users
       WHERE username = $1`,
      [username]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Erro ao buscar admin:', error);
    throw error;
  }
}

// Lista todos os admins (sem senha)
async function listAdminUsers() {
  try {
    const result = await pool.query(
      `SELECT id, username, created_at, updated_at, last_login
       FROM admin_users
       ORDER BY username ASC`
    );

    return result.rows;
  } catch (error) {
    console.error('Erro ao listar admins:', error);
    throw error;
  }
}

// Cria novo admin
async function createAdminUser(username, passwordHash) {
  try {
    const result = await pool.query(
      `INSERT INTO admin_users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username, created_at, updated_at, last_login`,
      [username, passwordHash]
    );

    return result.rows[0];
  } catch (error) {
    console.error('Erro ao criar admin:', error);
    throw error;
  }
}

// Atualiza senha do admin
async function updateAdminUserPassword(id, passwordHash) {
  try {
    const result = await pool.query(
      `UPDATE admin_users
       SET password_hash = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, username, created_at, updated_at, last_login`,
      [passwordHash, id]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Erro ao atualizar senha do admin:', error);
    throw error;
  }
}

// Atualiza última data de login do admin
async function touchAdminLastLogin(id) {
  try {
    await pool.query(
      `UPDATE admin_users
       SET last_login = NOW()
       WHERE id = $1`,
      [id]
    );
  } catch (error) {
    console.error('Erro ao atualizar último login do admin:', error);
    throw error;
  }
}

// Remove admin
async function deleteAdminUser(id) {
  try {
    await pool.query('DELETE FROM admin_users WHERE id = $1', [id]);
    return true;
  } catch (error) {
    console.error('Erro ao remover admin:', error);
    throw error;
  }
}

// Conta total de admins
async function countAdminUsers() {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) AS count FROM admin_users'
    );

    return parseInt(result.rows[0].count, 10);
  } catch (error) {
    console.error('Erro ao contar admins:', error);
    throw error;
  }
}

// Busca assinante por email e telefone
async function getSubscriberByEmailAndPhone(email, phone) {
  try {
    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone);
    const MIN_PHONE_MATCH = 6;

    const result = await pool.query(
      `SELECT id, name, email, phone, plan, status, origin
       FROM subscribers
       WHERE LOWER(TRIM(email)) = $1
         AND status = 'active'`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const matchesPhone = (storedPhone) => {
      const cleanedStored = normalizePhone(storedPhone);
      if (!cleanedStored) {
        return false;
      }

      if (cleanedStored === normalizedPhone) {
        return true;
      }

      if (cleanedStored.length < MIN_PHONE_MATCH || normalizedPhone.length < MIN_PHONE_MATCH) {
        return false;
      }

      if (normalizedPhone.endsWith(cleanedStored)) {
        return true;
      }

      if (cleanedStored.endsWith(normalizedPhone)) {
        return true;
      }

      return false;
    };

    for (const subscriber of result.rows) {
      if (matchesPhone(subscriber.phone)) {
        return subscriber;
      }
    }

    return null;
  } catch (error) {
    console.error('Erro ao buscar assinante:', error);
    throw error;
  }
}

// Busca usuário autorizado por Telegram ID
async function getUserByTelegramId(telegramId) {
  try {
    const result = await pool.query(
      `SELECT u.*, s.name, s.email, s.plan, s.status
       FROM authorized_users u
       LEFT JOIN subscribers s ON u.subscriber_id = s.id
       WHERE u.telegram_id = $1`,
      [telegramId]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Erro ao buscar usuário:', error);
    throw error;
  }
}

// Autoriza usuário no sistema
async function authorizeUser(telegramId, subscriber) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Verifica se já existe autorização
    const existing = await client.query(
      'SELECT id FROM authorized_users WHERE telegram_id = $1',
      [telegramId]
    );

    if (existing.rows.length > 0) {
      // Atualiza autorização existente
      await client.query(
        `UPDATE authorized_users 
         SET subscriber_id = $1, authorized = true, authorized_at = NOW()
         WHERE telegram_id = $2`,
        [subscriber.id, telegramId]
      );
    } else {
      // Cria nova autorização
      await client.query(
        `INSERT INTO authorized_users 
         (telegram_id, subscriber_id, authorized, authorized_at)
         VALUES ($1, $2, true, NOW())`,
        [telegramId, subscriber.id]
      );
    }

    // Registra log
    await client.query(
      `INSERT INTO authorization_logs 
       (telegram_id, subscriber_id, action, timestamp)
       VALUES ($1, $2, 'authorized', NOW())`,
      [telegramId, subscriber.id]
    );

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao autorizar usuário:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Busca canais por plano
async function getUserChannels(plan) {
  try {
    await schemaReady;
    const result = await pool.query(
      `SELECT id, name, chat_id, description, plan, order_index, active, creates_join_request
       FROM channels
       WHERE (plan = $1 OR plan = 'all') AND active = true
       ORDER BY order_index ASC`,
      [plan]
    );

    return result.rows;
  } catch (error) {
    console.error('Erro ao buscar canais:', error);
    throw error;
  }
}

async function saveUserInviteLink(telegramId, channelId, inviteLink, expireAt) {
  try {
    await schemaReady;
    await pool.query(
      `INSERT INTO user_invite_links (telegram_id, channel_id, invite_link, expire_at)
       VALUES ($1, $2, $3, $4)`,
      [telegramId, channelId, inviteLink, expireAt ? new Date(expireAt) : null]
    );
  } catch (error) {
    console.error('Erro ao salvar link de convite:', error);
    throw error;
  }
}

async function getActiveInviteLinksByTelegramId(telegramId) {
  try {
    await schemaReady;
    const result = await pool.query(
      `SELECT uil.id, uil.invite_link, uil.channel_id, uil.expire_at, c.chat_id
       FROM user_invite_links uil
       JOIN channels c ON c.id = uil.channel_id
       WHERE uil.telegram_id = $1
         AND uil.revoked_at IS NULL`,
      [telegramId]
    );

    return result.rows;
  } catch (error) {
    console.error('Erro ao buscar convites ativos:', error);
    throw error;
  }
}

async function markInviteLinksRevoked(ids) {
  if (!ids || ids.length === 0) {
    return;
  }

  const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');

  try {
    await pool.query(
      `UPDATE user_invite_links
       SET revoked_at = NOW()
       WHERE id IN (${placeholders})`,
      ids
    );
  } catch (error) {
    console.error('Erro ao marcar convites como revogados:', error);
    throw error;
  }
}

async function markInviteLinksRevokedByTelegramId(telegramId) {
  try {
    await schemaReady;
    await pool.query(
      `UPDATE user_invite_links
       SET revoked_at = NOW()
       WHERE telegram_id = $1 AND revoked_at IS NULL`,
      [telegramId]
    );
  } catch (error) {
    console.error('Erro ao revogar convites por usuário:', error);
    throw error;
  }
}


async function revokeTelegramAccess(telegramId, { plan } = {}) {
  if (!telegramId) {
    return;
  }

  await schemaReady;

  let userPlan = plan;

  if (!userPlan) {
    try {
      const result = await pool.query(
        `SELECT s.plan
         FROM authorized_users au
         JOIN subscribers s ON au.subscriber_id = s.id
         WHERE au.telegram_id = $1`,
        [telegramId]
      );

      userPlan = result.rows[0]?.plan;
    } catch (error) {
      console.error('Erro ao buscar plano do usuário para revogação:', error);
    }
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  let bot;

  if (!token) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN não configurado - não é possível revogar convites no Telegram.');
  } else {
    try {
      const TelegramBot = require('node-telegram-bot-api');
      bot = new TelegramBot(token, { polling: false });
    } catch (error) {
      console.error('⚠️ Erro ao inicializar bot para revogar acesso:', error);
    }
  }

  if (bot) {
    try {
      const activeInvites = await getActiveInviteLinksByTelegramId(telegramId);
      const inviteIds = [];

      for (const invite of activeInvites) {
        try {
          await bot.revokeChatInviteLink(invite.chat_id, invite.invite_link);
          inviteIds.push(invite.id);
        } catch (error) {
          console.error(`⚠️ Erro ao revogar convite ${invite.invite_link}:`, error.message);
        }

        await delay(300);
      }

      if (inviteIds.length > 0) {
        await markInviteLinksRevoked(inviteIds);
      }
    } catch (error) {
      console.error('Erro ao processar revogação de convites:', error);
    }
  }

  try {
    await markInviteLinksRevokedByTelegramId(telegramId);
  } catch (error) {
    console.error('Erro ao marcar convites como revogados:', error);
  }

  if (bot && userPlan) {
    try {
      const allChannels = await getAllChannels();
      const userChannels = allChannels.filter(
        (ch) => ch.plan === userPlan || ch.plan === 'all'
      );

      for (const channel of userChannels) {
        if (!channel.chat_id) {
          continue;
        }

        try {
          await bot.banChatMember(channel.chat_id, telegramId);
          await bot.unbanChatMember(channel.chat_id, telegramId);
        } catch (error) {
          console.error(`⚠️ Erro ao remover usuário do canal ${channel.name}:`, error.message);
        }

        await delay(500);
      }
    } catch (error) {
      console.error('Erro ao remover usuário dos canais:', error);
    }
  }
}


// Remove autorização de usuário
async function revokeAuthorization(telegramId) {
  try {
    await schemaReady;

    const userData = await pool.query(
      `SELECT au.subscriber_id, s.plan
       FROM authorized_users au
       LEFT JOIN subscribers s ON au.subscriber_id = s.id
       WHERE au.telegram_id = $1`,
      [telegramId]
    );

    const subscriberId = userData.rows[0]?.subscriber_id || null;
    const plan = userData.rows[0]?.plan;

    await revokeTelegramAccess(telegramId, { plan });

    await pool.query(
      'UPDATE authorized_users SET authorized = false WHERE telegram_id = $1',
      [telegramId]
    );

    await pool.query(
      `INSERT INTO authorization_logs
       (telegram_id, subscriber_id, action, timestamp)
       VALUES ($1, $2, 'revoked', NOW())`,
      [telegramId, subscriberId]
    );

    return true;
  } catch (error) {
    console.error('Erro ao revogar autorização:', error);
    throw error;
  }
}

// Busca estatísticas
async function getStats() {
  try {
    const totalUsers = await pool.query(
      'SELECT COUNT(*) as count FROM authorized_users WHERE authorized = true'
    );
    
    const totalSubscribers = await pool.query(
      'SELECT COUNT(*) as count FROM subscribers WHERE status = \'active\''
    );
    
    const byPlan = await pool.query(
      `SELECT s.plan, COUNT(*) as count 
       FROM authorized_users u
       JOIN subscribers s ON u.subscriber_id = s.id
       WHERE u.authorized = true
       GROUP BY s.plan`
    );

    return {
      totalAuthorizedUsers: parseInt(totalUsers.rows[0].count),
      totalActiveSubscribers: parseInt(totalSubscribers.rows[0].count),
      byPlan: byPlan.rows
    };
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    throw error;
  }
}

async function upsertSubscriberFromHotmart({ name, email, phone, plan, status = 'active' }) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error('Email é obrigatório para sincronizar assinante');
  }

  const normalizedPhone = normalizePhone(phone);
  const sanitizedName = name && name.trim() ? name.trim() : normalizedEmail;
  const sanitizedPlan = plan && plan.trim ? plan.trim() : plan;
  const sanitizedStatus = status || 'active';

  try {
    const result = await pool.query(
      `INSERT INTO subscribers (name, email, phone, plan, status, origin)
       VALUES ($1, $2, $3, $4, $5, 'hotmart')
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name,
             phone = EXCLUDED.phone,
             plan = EXCLUDED.plan,
             status = EXCLUDED.status,
             origin = 'hotmart',
             updated_at = NOW()
       RETURNING id, name, email, phone, plan, status, origin`,
      [sanitizedName, normalizedEmail, normalizedPhone, sanitizedPlan, sanitizedStatus]
    );

    return result.rows[0];
  } catch (error) {
    console.error('Erro ao sincronizar assinante via Hotmart:', error);
    throw error;
  }
}

// Busca assinante apenas por email
async function getSubscriberByEmail(email) {
  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, plan, status, origin
       FROM subscribers
       WHERE LOWER(TRIM(email)) = $1`,
      [normalizeEmail(email)]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Erro ao buscar assinante por email:', error);
    throw error;
  }
}

async function deactivateSubscriberByEmail(email) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return null;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const subscriberResult = await client.query(
      `SELECT id, name, email, phone, plan, status, origin
       FROM subscribers
       WHERE LOWER(TRIM(email)) = $1`,
      [normalizedEmail]
    );

    if (subscriberResult.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }

    const subscriber = subscriberResult.rows[0];

    const authorizedResult = await client.query(
      `SELECT telegram_id
       FROM authorized_users
       WHERE subscriber_id = $1`,
      [subscriber.id]
    );

    let updatedSubscriber = subscriber;

    if (subscriber.status !== 'inactive') {
      const updateResult = await client.query(
        `UPDATE subscribers
         SET status = 'inactive', updated_at = NOW()
         WHERE id = $1
         RETURNING id, name, email, phone, plan, status, origin`,
        [subscriber.id]
      );

      updatedSubscriber = updateResult.rows[0];
    }

    await client.query('COMMIT');

    for (const row of authorizedResult.rows) {
      if (row.telegram_id) {
        try {
          await revokeAuthorization(row.telegram_id);
        } catch (error) {
          console.error('Erro ao revogar autorização durante desativação por email:', error);
        }
      }
    }

    return updatedSubscriber;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao desativar assinante por email:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Busca usuário autorizado por subscriber_id
async function getUserBySubscriberId(subscriberId) {
  try {
    const result = await pool.query(
      `SELECT * FROM authorized_users WHERE subscriber_id = $1`,
      [subscriberId]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Erro ao buscar usuário por subscriber_id:', error);
    throw error;
  }
}

// Remove acesso do usuário completamente (DELETA da tabela)
async function revokeUserAccess(subscriberId) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Busca dados do usuário antes de deletar
    const authorizedUser = await client.query(
      `SELECT au.telegram_id, s.plan 
       FROM authorized_users au
       JOIN subscribers s ON au.subscriber_id = s.id
       WHERE au.subscriber_id = $1`,
      [subscriberId]
    );

    const telegramId = authorizedUser.rows[0]?.telegram_id;
    const plan = authorizedUser.rows[0]?.plan;

    // Remove dos grupos do Telegram (se tiver telegram_id)
    if (telegramId) {
      await revokeTelegramAccess(telegramId, { plan });
    }

    // Registra log ANTES de deletar
    await client.query(
      `INSERT INTO authorization_logs (telegram_id, subscriber_id, action, timestamp)
       VALUES ($1, $2, 'revoked', NOW())`,
      [telegramId || 'N/A', subscriberId]
    );

    // Remove autorização do banco
    await client.query(
      'DELETE FROM authorized_users WHERE subscriber_id = $1',
      [subscriberId]
    );

    // DELETA o assinante completamente (não marca como inactive)
    await client.query(
      `DELETE FROM subscribers WHERE id = $1`,
      [subscriberId]
    );

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao revogar acesso:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Busca todos os usuários que já foram autorizados alguma vez
async function getAllAuthorizedUsers() {
  try {
    const result = await pool.query(
      `SELECT DISTINCT au.telegram_id, s.name, s.email, au.authorized
       FROM authorized_users au
       LEFT JOIN subscribers s ON au.subscriber_id = s.id`
    );

    return result.rows;
  } catch (error) {
    console.error('Erro ao buscar usuários autorizados:', error);
    throw error;
  }
}

// ============== FUNÇÕES ADMIN ==============

// Listar todos os assinantes
async function getAllSubscribers() {
  try {
    const result = await pool.query(
      `SELECT s.*, 
              au.telegram_id, 
              au.authorized, 
              au.authorized_at
       FROM subscribers s
       LEFT JOIN authorized_users au ON s.id = au.subscriber_id
       ORDER BY s.created_at DESC`
    );
    return result.rows;
  } catch (error) {
    console.error('Erro ao buscar assinantes:', error);
    throw error;
  }
}

// Buscar assinante por ID
async function getSubscriberById(id) {
  try {
    const result = await pool.query(
      'SELECT * FROM subscribers WHERE id = $1',
      [id]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Erro ao buscar assinante:', error);
    throw error;
  }
}

// Criar novo assinante
async function createSubscriber(name, email, phone, plan) {
  try {
    const result = await pool.query(
      `INSERT INTO subscribers (name, email, phone, plan, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING *`,
      [name?.trim(), normalizeEmail(email), normalizePhone(phone), plan?.trim()]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Erro ao criar assinante:', error);
    throw error;
  }
}

// Atualizar assinante
async function updateSubscriber(id, name, email, phone, plan, status) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Pega status anterior
    const oldData = await client.query(
      'SELECT status FROM subscribers WHERE id = $1',
      [id]
    );
    
    // Atualiza subscriber
    await client.query(
      `UPDATE subscribers
       SET name = $1, email = $2, phone = $3, plan = $4, status = $5, updated_at = NOW()
       WHERE id = $6`,
      [name?.trim(), normalizeEmail(email), normalizePhone(phone), plan?.trim(), status, id]
    );
    
    // Se mudou para inactive, revoga autorização E REMOVE DOS GRUPOS
    if (oldData.rows.length > 0 && oldData.rows[0].status === 'active' && status === 'inactive') {
      // Busca telegram_id e plano antes de revogar
      const authUser = await client.query(
        `SELECT au.telegram_id, s.plan 
         FROM authorized_users au
         JOIN subscribers s ON au.subscriber_id = s.id
         WHERE au.subscriber_id = $1`,
        [id]
      );

      const telegramId = authUser.rows[0]?.telegram_id;
      const userPlan = authUser.rows[0]?.plan;
      const tgId = telegramId || 'N/A';

      // Remove dos grupos do Telegram
      if (telegramId) {
        await revokeTelegramAccess(telegramId, { plan: userPlan });
      }

      await client.query(
        'UPDATE authorized_users SET authorized = false WHERE subscriber_id = $1',
        [id]
      );
      
      // Registra log COM telegram_id
      await client.query(
        `INSERT INTO authorization_logs (telegram_id, subscriber_id, action, timestamp)
         VALUES ($1, $2, 'revoked', NOW())`,
        [tgId, id]
      );
    }
    
    // Se mudou para active, permite autorização novamente
    if (oldData.rows.length > 0 && oldData.rows[0].status === 'inactive' && status === 'active') {
      await client.query(
        'UPDATE authorized_users SET authorized = true WHERE subscriber_id = $1',
        [id]
      );
    }
    
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar assinante:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Listar todos os canais
async function getAllChannels() {
  try {
    await schemaReady;
    const result = await pool.query(
      'SELECT * FROM channels ORDER BY plan, order_index'
    );
    return result.rows;
  } catch (error) {
    console.error('Erro ao buscar canais:', error);
    throw error;
  }
}

// Criar novo canal
async function createChannel(name, chat_id, description, plan, order_index, creates_join_request = false) {
  try {
    await schemaReady;
    const result = await pool.query(
      `INSERT INTO channels (name, chat_id, description, plan, order_index, active, creates_join_request)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       RETURNING *`,
      [name, chat_id, description, plan, order_index || 0, creates_join_request]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Erro ao criar canal:', error);
    throw error;
  }
}

// Atualizar canal
async function updateChannel(id, name, chat_id, description, plan, order_index, active, creates_join_request = false) {
  try {
    await schemaReady;
    await pool.query(
      `UPDATE channels
       SET name = $1, chat_id = $2, description = $3, plan = $4, order_index = $5, active = $6, creates_join_request = $7, updated_at = NOW()
       WHERE id = $8`,
      [name, chat_id, description, plan, order_index, active, creates_join_request, id]
    );
    return true;
  } catch (error) {
    console.error('Erro ao atualizar canal:', error);
    throw error;
  }
}

// Deletar canal
async function deleteChannel(id) {
  try {
    await pool.query('DELETE FROM channels WHERE id = $1', [id]);
    return true;
  } catch (error) {
    console.error('Erro ao deletar canal:', error);
    throw error;
  }
}

// Buscar logs de autorização
async function getAuthorizationLogs() {
  try {
    const result = await pool.query(
      `SELECT l.*, s.name, s.email 
       FROM authorization_logs l
       LEFT JOIN subscribers s ON l.subscriber_id = s.id
       ORDER BY l.timestamp DESC
       LIMIT 100`
    );
    return result.rows;
  } catch (error) {
    console.error('Erro ao buscar logs:', error);
    throw error;
  }
}

module.exports = {
  pool,
  // Admins
  getAdminUserByUsername,
  listAdminUsers,
  createAdminUser,
  updateAdminUserPassword,
  deleteAdminUser,
  countAdminUsers,
  touchAdminLastLogin,
  getSubscriberByEmailAndPhone,
  upsertSubscriberFromHotmart,
  getSubscriberByEmail,
  getUserByTelegramId,
  getUserBySubscriberId,
  authorizeUser,
  getUserChannels,
  saveUserInviteLink,
  getActiveInviteLinksByTelegramId,
  markInviteLinksRevoked,
  markInviteLinksRevokedByTelegramId,
  revokeAuthorization,
  revokeUserAccess,
  getAllAuthorizedUsers,
  getStats,
  // Novas funções admin
  getAllSubscribers,
  getSubscriberById,
  createSubscriber,
  updateSubscriber,
  getAllChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  getAuthorizationLogs,
  deactivateSubscriberByEmail
};