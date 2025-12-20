const { Pool } = require('pg');
const { normalizePhone, phonesMatch } = require('./phone-utils');

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
      `ALTER TABLE subscribers
       ALTER COLUMN plan TYPE TEXT`
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
        link: 'https://web.telegram.org/k/#-3268530938',
        plan: 'Mentoria Renda Turbinada',
        orderIndex: 0
      }
    ];

    for (const channel of requiredChannels) {
      const exists = await pool.query(
        `SELECT 1
         FROM channels
         WHERE chat_id = $1 OR (plan = $2 AND name = $3)
         LIMIT 1`,
        [channel.chatId, channel.plan, channel.name]
      );

      if (exists.rowCount === 0) {
        await pool.query(
          `INSERT INTO channels (name, chat_id, link, description, plan, order_index, active, creates_join_request)
           VALUES ($1, $2, $3, $4, $5, $6, true, false)`,
          [
            channel.name,
            channel.chatId,
            channel.link,
            channel.description,
            channel.plan,
            channel.orderIndex
          ]
        );
      }
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

// Helper para normalizar email
function normalizeEmail(email) {
  if (!email) return '';
  return email.trim().toLowerCase();
}

// Normaliza plano(s) para um array de valores únicos
function normalizePlanList(plan) {
  if (!plan) return [];

  if (Array.isArray(plan)) {
    return [...new Set(plan.map((p) => String(p || '').trim()).filter(Boolean))];
  }

  if (typeof plan === 'string') {
    return [
      ...new Set(
        plan
          .split(/[,;\n]/)
          .map((p) => p.trim())
          .filter(Boolean)
      )
    ];
  }

  return [];
}

function formatPlanList(plan) {
  return normalizePlanList(plan).join(', ');
}

function mergePlanValues(existingPlan, incomingPlan) {
  const merged = [
    ...normalizePlanList(existingPlan),
    ...normalizePlanList(incomingPlan)
  ];

  return formatPlanList(merged);
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

    const result = await pool.query(
      `SELECT id, name, email, phone, plan, status, origin
       FROM subscribers
       WHERE LOWER(TRIM(email)) = $1
         AND status = 'active'`,
      [normalizedEmail]
    );

    if (result.rows.length === 0 || !normalizedPhone) {
      return null;
    }

    for (const subscriber of result.rows) {
      if (phonesMatch(normalizedPhone, subscriber.phone)) {
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

    const planList = normalizePlanList(plan);
    const result = await pool.query(
      `SELECT id, name, chat_id, description, plan, order_index, active, creates_join_request
       FROM channels
       WHERE (plan = 'all' OR plan = ANY($1)) AND active = true
       ORDER BY order_index ASC`,
      [planList]
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
      `SELECT uil.id, uil.invite_link, uil.channel_id, uil.expire_at, c.chat_id, c.plan, c.active
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


async function revokeTelegramAccess(telegramId, { plan, revokedPlans } = {}) {
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

  const targetPlanList = normalizePlanList(revokedPlans || userPlan);
  const shouldFilterByPlan = Array.isArray(revokedPlans) || typeof revokedPlans === 'string';

  if (bot) {
    try {
      const activeInvites = await getActiveInviteLinksByTelegramId(telegramId);
      const inviteIds = [];

      for (const invite of activeInvites) {
        if (shouldFilterByPlan) {
          if (!invite.plan || !targetPlanList.includes(invite.plan)) {
            continue;
          }

          if (invite.active === false) {
            continue;
          }
        }

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

  if (!shouldFilterByPlan) {
    try {
      await markInviteLinksRevokedByTelegramId(telegramId);
    } catch (error) {
      console.error('Erro ao marcar convites como revogados:', error);
    }
  }

  const userPlanList = normalizePlanList(userPlan);

  const planListForChannels = shouldFilterByPlan ? targetPlanList : userPlanList;
  const includeAllChannels = !shouldFilterByPlan;

  if (bot && planListForChannels.length > 0) {
    try {
      const allChannels = await getAllChannels();
      const userChannels = allChannels.filter(
        (ch) =>
          ch.active &&
          ((includeAllChannels && ch.plan === 'all') || planListForChannels.includes(ch.plan))
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
  const sanitizedStatus = status || 'active';
  const sanitizedPlan = plan && plan.trim ? plan.trim() : plan;

  let finalPlan = formatPlanList(sanitizedPlan);

  try {
    const existing = await getSubscriberByEmail(normalizedEmail);

    if (existing) {
      finalPlan = mergePlanValues(existing.plan, sanitizedPlan);
    }
  } catch (error) {
    console.error('Erro ao mesclar planos existentes:', error);
  }

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
      [sanitizedName, normalizedEmail, normalizedPhone, finalPlan, sanitizedStatus]
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

async function deactivateSubscriberByEmail(email, { plan } = {}) {
  const normalizedEmail = normalizeEmail(email);
  const targetPlan = plan && String(plan).trim();

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
    const currentPlans = normalizePlanList(subscriber.plan);
    const isPlanScoped = Boolean(targetPlan);
    let planRevoked = false;

    if (isPlanScoped) {
      const remainingPlans = currentPlans.filter(
        (p) => p.toLowerCase() !== targetPlan.toLowerCase()
      );

      planRevoked = remainingPlans.length !== currentPlans.length;

      if (planRevoked) {
        const nextStatus =
          remainingPlans.length === 0
            ? 'inactive'
            : subscriber.status === 'inactive'
              ? 'inactive'
              : 'active';

        const updateResult = await client.query(
          `UPDATE subscribers
           SET plan = $1, status = $2, updated_at = NOW()
           WHERE id = $3
           RETURNING id, name, email, phone, plan, status, origin`,
          [formatPlanList(remainingPlans), nextStatus, subscriber.id]
        );

        updatedSubscriber = updateResult.rows[0];
      }
    } else if (subscriber.status !== 'inactive') {
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

    const remainingPlansAfterUpdate = normalizePlanList(updatedSubscriber.plan);
    const shouldFullyRevoke = !isPlanScoped || remainingPlansAfterUpdate.length === 0;

    if (!isPlanScoped || planRevoked) {
      for (const row of authorizedResult.rows) {
        if (!row.telegram_id) {
          continue;
        }

        try {
          if (shouldFullyRevoke) {
            await revokeAuthorization(row.telegram_id);
          } else {
            await revokeTelegramAccess(row.telegram_id, {
              plan: updatedSubscriber.plan,
              revokedPlans: targetPlan
            });
          }
        } catch (error) {
          console.error('Erro ao revogar autorização durante desativação por email:', error);
        }
      }
    }

    return { ...updatedSubscriber, planRevoked };
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
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const sanitizedName = name?.trim() || normalizedEmail;
  const formattedPlan = formatPlanList(plan);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingResult = await client.query(
      `SELECT id, plan
       FROM subscribers
       WHERE LOWER(TRIM(email)) = $1
       LIMIT 1`,
      [normalizedEmail]
    );

    let subscriberRow;

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      const mergedPlan = mergePlanValues(existing.plan, formattedPlan);

      const updateResult = await client.query(
        `UPDATE subscribers
         SET name = $1,
             email = $2,
             phone = $3,
             plan = $4,
             status = 'active',
             updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [sanitizedName, normalizedEmail, normalizedPhone, mergedPlan, existing.id]
      );

      subscriberRow = updateResult.rows[0];
    } else {
      const insertResult = await client.query(
        `INSERT INTO subscribers (name, email, phone, plan, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING *`,
        [sanitizedName, normalizedEmail, normalizedPhone, formattedPlan]
      );

      subscriberRow = insertResult.rows[0];
    }

    await client.query('COMMIT');
    return subscriberRow;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar assinante:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Atualizar assinante
async function updateSubscriber(id, name, email, phone, plan, status) {
  const client = await pool.connect();
  const formattedPlan = formatPlanList(plan);
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const trimmedName = name?.trim();

  try {
    await client.query('BEGIN');

    // Pega status anterior
    const oldData = await client.query(
      'SELECT status, plan FROM subscribers WHERE id = $1',
      [id]
    );

    // Atualiza subscriber
    await client.query(
      `UPDATE subscribers
       SET name = $1, email = $2, phone = $3, plan = $4, status = $5, updated_at = NOW()
       WHERE id = $6`,
      [trimmedName, normalizedEmail, normalizedPhone, formattedPlan, status, id]
    );

    const previousPlanList = normalizePlanList(oldData.rows[0]?.plan);
    const updatedPlanList = normalizePlanList(formattedPlan);
    const removedPlans = previousPlanList.filter((p) => !updatedPlanList.includes(p));

    const authorizedUser = await client.query(
      `SELECT telegram_id
       FROM authorized_users
       WHERE subscriber_id = $1`,
      [id]
    );

    const telegramId = authorizedUser.rows[0]?.telegram_id;

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
    } else if (telegramId && removedPlans.length > 0) {
      try {
        await revokeTelegramAccess(telegramId, { revokedPlans: removedPlans });
      } catch (error) {
        console.error('Erro ao revogar planos específicos:', error);
      }
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
