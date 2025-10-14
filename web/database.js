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
       ADD COLUMN IF NOT EXISTS creates_join_request BOOLEAN NOT NULL DEFAULT false`
    );
  } catch (error) {
    console.error('Erro ao garantir coluna creates_join_request:', error);
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
      `SELECT id, name, email, phone, plan, status
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


// Remove autorização de usuário
async function revokeAuthorization(telegramId) {
  try {
    await pool.query(
      'UPDATE authorized_users SET authorized = false WHERE telegram_id = $1',
      [telegramId]
    );

    await pool.query(
      `INSERT INTO authorization_logs 
       (telegram_id, action, timestamp)
       VALUES ($1, 'revoked', NOW())`,
      [telegramId]
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

// Busca assinante apenas por email
async function getSubscriberByEmail(email) {
  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, plan, status
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
    if (telegramId && plan) {
      try {
        const TelegramBot = require('node-telegram-bot-api');
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const bot = new TelegramBot(token);
        
        const allChannels = await getAllChannels();
        const userChannels = allChannels.filter(
          ch => ch.plan === plan || ch.plan === 'all'
        );
        
        for (const channel of userChannels) {
          try {
            await bot.banChatMember(channel.chat_id, telegramId);
            await bot.unbanChatMember(channel.chat_id, telegramId);
            console.log(`✅ Removido do canal: ${channel.name}`);
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (error) {
            console.log(`⚠️ Erro ao remover do canal ${channel.name}`);
          }
        }
      } catch (telegramError) {
        console.error('⚠️ Erro ao remover do Telegram:', telegramError);
      }
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
      if (telegramId && userPlan) {
        try {
          const TelegramBot = require('node-telegram-bot-api');
          const token = process.env.TELEGRAM_BOT_TOKEN;
          const bot = new TelegramBot(token);
          
          const allChannels = await getAllChannels();
          const userChannels = allChannels.filter(
            ch => ch.plan === userPlan || ch.plan === 'all'
          );
          
          for (const channel of userChannels) {
            try {
              await bot.banChatMember(channel.chat_id, telegramId);
              await bot.unbanChatMember(channel.chat_id, telegramId);
              console.log(`✅ Removido do canal: ${channel.name}`);
              await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
              console.log(`⚠️ Erro ao remover do canal ${channel.name}`);
            }
          }
        } catch (telegramError) {
          console.error('⚠️ Erro ao remover do Telegram:', telegramError);
        }
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
  getSubscriberByEmail,
  getUserByTelegramId,
  getUserBySubscriberId,
  authorizeUser,
  getUserChannels,
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
  getAuthorizationLogs
};