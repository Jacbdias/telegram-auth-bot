const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const db = require('../web/database');
const cache = require('./cache');
const logger = require('../shared/logger');

const token = process.env.TELEGRAM_BOT_TOKEN;
const rawWebAppUrl = process.env.WEB_APP_URL;
const webAppUrl = rawWebAppUrl ? rawWebAppUrl.replace(/\/+$/, '') : '';
const supportUsername = process.env.SUPPORT_USERNAME || '@suportefatosdabolsa';

const bot = new TelegramBot(token, { polling: true });

const INVITE_DURATION_HOURS = 72;
const INVITE_MEMBER_LIMIT = 1;
const USER_CACHE_TTL_MS = 5 * 60 * 1000;
const SUBSCRIBER_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUIRED_CHANNELS_CACHE_TTL_MS = 10 * 60 * 1000;
const MEMBERSHIP_CACHE_TTL_MS = 2 * 60 * 1000;

async function getCachedUserByTelegramId(telegramId) {
  const telegramIdStr = telegramId.toString();
  const key = `user:tg:${telegramIdStr}`;
  const cached = cache.get(key);

  if (cached) {
    logger.info('cache_hit_user_telegram', { telegram_id: telegramIdStr });
    return cached;
  }

  logger.info('cache_miss_user_telegram', { telegram_id: telegramIdStr });

  const user = await db.getUserByTelegramId(telegramIdStr);

  if (user) {
    cache.set(key, user, USER_CACHE_TTL_MS);

    if (user.subscriber_id) {
      cache.set(`sub:${user.subscriber_id}`, user, SUBSCRIBER_CACHE_TTL_MS);
    }
  }

  return user;
}

async function getCachedChannelsForPlan(plan) {
  const requiredChannelsKey = 'channels:required';
  let channels = cache.get(requiredChannelsKey);

  if (!channels) {
    logger.info('cache_miss_channels_required');
    channels = await db.getAllChannels();
    cache.set(requiredChannelsKey, channels, REQUIRED_CHANNELS_CACHE_TTL_MS);
  } else {
    logger.info('cache_hit_channels_required');
  }

  const planList = String(plan || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return channels
    .filter((channel) => channel.active && (channel.plan === 'all' || planList.includes(channel.plan)))
    .sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
}

async function revokeExistingInvites(telegramId) {
  try {
    const telegramIdStr = telegramId.toString();
    cache.invalidatePattern(`membership:${telegramIdStr}:`);
    const activeInvites = await db.getActiveInviteLinksByTelegramId(telegramIdStr);

    if (activeInvites.length === 0) {
      return;
    }

    const revokedIds = [];

    for (const invite of activeInvites) {
      try {
        await bot.revokeChatInviteLink(invite.chat_id, invite.invite_link);
        revokedIds.push(invite.id);
      } catch (error) {
        console.error(`Erro ao revogar link ${invite.invite_link}:`, error.message);
      }

      await new Promise(resolve => setTimeout(resolve, 300));
    }

    if (revokedIds.length > 0) {
      await db.markInviteLinksRevoked(revokedIds);
    }
    } catch (error) {
      console.error('Erro ao revogar convites existentes:', error.message);
      logger.error('telegram_revoke_invites_error', { telegram_id: telegramIdStr, error: error.message });
  }
}

async function generateInviteLinksForUser(telegramId, channels) {
  const telegramIdStr = telegramId.toString();
  let message = '';

  for (const channel of channels) {
    if (!channel.chat_id) {
      console.warn(`Canal sem chat_id configurado: ${channel.name}`);
      message += `• ${channel.name}\n  ⚠️ Canal sem chat_id configurado. Contate o suporte.\n\n`;
      continue;
    }

    try {
      const expireAt = new Date(Date.now() + INVITE_DURATION_HOURS * 60 * 60 * 1000);
      const inviteOptions = {
        member_limit: INVITE_MEMBER_LIMIT,
        expire_date: Math.floor(expireAt.getTime() / 1000)
      };

      if (channel.creates_join_request) {
        inviteOptions.creates_join_request = true;
      }

      const membershipKey = `membership:${telegramIdStr}:${channel.id}`;
      let isMember = cache.get(membershipKey);

      if (isMember === null) {
        try {
          const member = await bot.getChatMember(channel.chat_id, telegramIdStr);
          isMember = ['member', 'administrator', 'creator'].includes(member.status);
        } catch (membershipError) {
          isMember = false;
        }

        cache.set(membershipKey, isMember, MEMBERSHIP_CACHE_TTL_MS);
      }

      if (!isMember) {
        try {
          await bot.unbanChatMember(channel.chat_id, telegramIdStr);
        } catch (unbanError) {
          console.warn(`Não foi possível desbanir ${telegramIdStr} em ${channel.name}:`, unbanError.message);
        }
      }

      const inviteLink = await bot.createChatInviteLink(channel.chat_id, inviteOptions);

      await db.saveUserInviteLink(telegramIdStr, channel.id, inviteLink.invite_link, expireAt);
      cache.invalidate(`membership:${telegramIdStr}:${channel.id}`);

      console.log(`✅ Link criado para: ${channel.name}`);

      message += `• ${channel.name}\n  ${inviteLink.invite_link}\n\n`;
    } catch (error) {
      console.error(`Erro ao criar link para ${channel.name}:`, error.message);
      logger.error('telegram_invite_creation_error', {
        telegram_id: telegramIdStr,
        chat_id: channel.chat_id,
        error: error.message
      });
      message += `• ${channel.name}\n  ⚠️ Erro ao gerar link\n\n`;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return message;
}

// Armazena tokens temporários (em produção, use Redis)
const verificationTokens = new Map();

// Comando /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name;

  // Verifica se usuário já está autorizado
  const user = await getCachedUserByTelegramId(chatId);
  
  if (user && user.authorized) {
    return bot.sendMessage(chatId, 
      `✅ Olá *${username}*!\n\n` +
      `Você já está autorizado e tem acesso aos canais.\n\n` +
      `Digite /meuscanais para ver seus acessos.`,
      { parse_mode: 'Markdown' }
    );
  }

  const welcomeMessage = 
    `Olá *${username}*! 👋\n\n` +
    `Para entrar nos nossos canais exclusivos para assinantes, ` +
    `precisamos que você se identifique.\n\n` +
    `👇 Clique no botão abaixo para iniciar o processo de verificação.\n\n` +
    `⚠️ Caso esteja com algum problema, entre em contato com nosso suporte: ${supportUsername}`;

  const keyboard = {
    inline_keyboard: [[
      { 
        text: '🔐 Verificar Identidade', 
        callback_data: 'verify_identity' 
      }
    ]]
  };

  bot.sendMessage(chatId, welcomeMessage, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

// Callback quando usuário clica em "Verificar Identidade"
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === 'verify_identity') {
    // Gera token único para verificação
    const token = crypto.randomBytes(32).toString('hex');
    const telegramId = chatId.toString();

    // Armazena token com expiração de 15 minutos
    verificationTokens.set(token, {
      telegramId,
      timestamp: Date.now(),
      expires: Date.now() + (15 * 60 * 1000) // 15 minutos
    });

    // Limpa tokens expirados (executa a cada verificação)
    cleanExpiredTokens();

    if (!webAppUrl) {
      console.error('WEB_APP_URL não está configurada.');
      bot.sendMessage(chatId,
        '⚠️ Não foi possível gerar o link de verificação no momento.\n' +
        `Entre em contato com o suporte: ${supportUsername}`
      );
      bot.answerCallbackQuery(query.id);
      return;
    }

    const verificationUrl = `${webAppUrl}/verify?token=${token}`;

    const message = 
      `🔗 Link de verificação gerado!\n\n` +
      `Clique no link abaixo para se identificar:\n` +
      `${verificationUrl}\n\n` +
      `⏱ Este link expira em 15 minutos.\n\n` +
      `🔒 Por segurança, não compartilhe este link com ninguém.`;

    bot.sendMessage(chatId, message);
    bot.answerCallbackQuery(query.id);
  }
});

// Comando /meuscanais
bot.onText(/\/meuscanais/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await getCachedUserByTelegramId(chatId);

  if (!user || !user.authorized) {
    return bot.sendMessage(chatId, 
      '❌ Você ainda não está autorizado.\n\n' +
      'Use /start para iniciar o processo de verificação.'
    );
  }

  const channels = await getCachedChannelsForPlan(user.plan);

  if (channels.length === 0) {
    return bot.sendMessage(chatId,
      '⚠️ Nenhum canal disponível para seu plano.\n\n' +
      `Entre em contato com o suporte: ${supportUsername}`
    );
  }

  await revokeExistingInvites(chatId);

  let message = `✅ *Seus Canais* (Plano: ${user.plan})\n\n`;

  message += await generateInviteLinksForUser(chatId, channels);

  message += `\n💡 Links de uso único que expiram em ${INVITE_DURATION_HOURS}h.`;

  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// Função chamada quando verificação é bem-sucedida
async function notifyUserAuthorized(telegramId, userData) {
  const channels = await getCachedChannelsForPlan(userData.plan);
  logger.info('user_authorized', {
    telegram_id: String(telegramId),
    plan: userData.plan,
    channels_affected: channels.length
  });

  await revokeExistingInvites(telegramId);
  const generatedLinksMessage = await generateInviteLinksForUser(telegramId, channels);

  // Escapa caracteres especiais do Markdown
  const escapedName = userData.name.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  const escapedPlan = userData.plan.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

  let message =
    `✅ *Verificação Concluída com Sucesso\\!*\n\n` +
    `Bem\\-vindo\\(a\\), ${escapedName}\\!\n\n` +
    `📋 *Seu Plano:* ${escapedPlan}\n\n` +
    `🔗 *Clique nos links abaixo para entrar nos grupos:*\n\n`;

  message += generatedLinksMessage;

  message +=
    `\n⚠️ *IMPORTANTE:*\n` +
    `• Estes links são de uso único\n` +
    `• Expiram em ${INVITE_DURATION_HOURS} horas\n` +
    `• Não compartilhe com outras pessoas\n\n` +
    `💡 Use /meuscanais para solicitar novos links se necessário\\.`;

  try {
    await bot.sendMessage(telegramId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Erro ao enviar mensagem de verificação:', error.message);
    logger.error('telegram_send_message_error', {
      telegram_id: String(telegramId),
      error: error.message
    });
    
    // Fallback: tenta enviar sem formatação
    const plainMessage = 
      `✅ Verificação Concluída com Sucesso!\n\n` +
      `Bem-vindo(a), ${userData.name}!\n\n` +
      `📋 Seu Plano: ${userData.plan}\n\n` +
      `🔗 Clique nos links abaixo para entrar nos grupos:\n\n` +
      generatedLinksMessage +
      `\n⚠️ IMPORTANTE:\n` +
      `• Estes links são de uso único\n` +
      `• Expiram em ${INVITE_DURATION_HOURS} horas\n` +
      `• Não compartilhe com outras pessoas\n\n` +
      `💡 Use /meuscanais para solicitar novos links se necessário.`;
    
    await bot.sendMessage(telegramId, plainMessage);
  }
}

// Função para validar token
function validateToken(token) {
  const data = verificationTokens.get(token);
  
  if (!data) {
    return null;
  }

  if (Date.now() > data.expires) {
    verificationTokens.delete(token);
    return null;
  }

  return data;
}

// Remove token após uso
function consumeToken(token) {
  verificationTokens.delete(token);
}

// Limpa tokens expirados
function cleanExpiredTokens() {
  const now = Date.now();
  for (const [token, data] of verificationTokens.entries()) {
    if (now > data.expires) {
      verificationTokens.delete(token);
    }
  }
}

// Limpa tokens expirados a cada 5 minutos
setInterval(cleanExpiredTokens, 5 * 60 * 1000);

setInterval(() => {
  logger.info('cache_stats', cache.getStats());
}, 5 * 60 * 1000);

// Comando /revogar (apenas para admins)
bot.onText(/\/revogar (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const email = match[1].trim();

  // Lista de IDs de admins autorizados (SUBSTITUA pelos IDs reais)
const adminIds = ['1839742847']; // Seu Telegram ID
  
  if (!adminIds.includes(chatId.toString())) {
    return bot.sendMessage(chatId, '❌ Você não tem permissão para usar este comando.');
  }

  try {
    // Busca o assinante pelo email
    const subscriber = await db.getSubscriberByEmail(email);
    
    if (!subscriber) {
      return bot.sendMessage(chatId, 
        `❌ Nenhum assinante encontrado com o email: ${email}`
      );
    }

    // Busca se tem usuário autorizado vinculado
    const authorizedUser = await db.getUserBySubscriberId(subscriber.id);
    
    if (authorizedUser && authorizedUser.telegram_id) {
      cache.invalidate(`user:tg:${authorizedUser.telegram_id}`);
      cache.invalidatePattern(`membership:${authorizedUser.telegram_id}:`);
      await revokeExistingInvites(authorizedUser.telegram_id);

      // Tenta remover de todos os canais
      const channels = await getCachedChannelsForPlan(subscriber.plan);
      let removedCount = 0;
      let failedChannels = [];

      for (const channel of channels) {
        try {
          await bot.banChatMember(channel.chat_id, authorizedUser.telegram_id);
          // Desban imediatamente (apenas remove, não bloqueia)
          await bot.unbanChatMember(channel.chat_id, authorizedUser.telegram_id);
          removedCount++;
          console.log(`✅ Removido de: ${channel.name}`);
        } catch (error) {
          console.error(`❌ Erro ao remover de ${channel.name}:`, error.message);
          failedChannels.push(channel.name);
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Envia mensagem ao usuário informando
      try {
        const userMessage = 
          `⚠️ *Acesso Revogado*\n\n` +
          `Olá ${subscriber.name},\n\n` +
          `Não encontramos uma assinatura ativa vinculada à sua conta.\n\n` +
          `Seu acesso aos canais exclusivos foi removido.\n\n` +
          `Se você acredita que isso é um erro ou deseja renovar sua assinatura, ` +
          `entre em contato com nosso suporte: ${supportUsername}\n\n` +
          `_Equipe Fatos da Bolsa_`;

        await bot.sendMessage(authorizedUser.telegram_id, userMessage, { parse_mode: 'Markdown' });
      } catch (msgError) {
        console.error('Não foi possível enviar mensagem ao usuário:', msgError.message);
      }
    }

    // Remove do banco de dados
    await db.revokeUserAccess(subscriber.id);
    logger.info('user_revoked', {
      subscriber_id: subscriber.id,
      telegram_id: authorizedUser?.telegram_id || null,
      plan: subscriber.plan,
      channels_affected: removedCount || 0
    });

    // Confirma ao admin
    let confirmMessage = 
      `✅ *Usuário Revogado com Sucesso!*\n\n` +
      `📧 Email: ${email}\n` +
      `👤 Nome: ${subscriber.name}\n` +
      `📋 Plano: ${subscriber.plan}\n\n`;

    if (authorizedUser) {
      confirmMessage += 
        `🆔 Telegram ID: ${authorizedUser.telegram_id}\n` +
        `📤 Removido de ${removedCount} ${removedCount === 1 ? 'canal' : 'canais'}\n`;
      
      if (failedChannels.length > 0) {
        confirmMessage += `\n⚠️ Falha ao remover de:\n`;
        failedChannels.forEach(name => {
          confirmMessage += `• ${name}\n`;
        });
      }
    } else {
      confirmMessage += `\nℹ️ Usuário não tinha Telegram vinculado.`;
    }

    bot.sendMessage(chatId, confirmMessage, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Erro ao revogar acesso:', error);
    bot.sendMessage(chatId, 
      `❌ Erro ao revogar acesso: ${error.message}`
    );
  }
});

// Comando /help para admins
bot.onText(/\/ajuda_admin/, (msg) => {
  const chatId = msg.chat.id;
  
  const helpMessage = 
    `🔧 *Comandos Administrativos*\n\n` +
    `📋 *Sintaxe:*\n` +
    `/revogar email@usuario.com\n\n` +
    `📝 *O que faz:*\n` +
    `• Remove o usuário de todos os canais\n` +
    `• Apaga autorização do banco\n` +
    `• Notifica o usuário sobre a remoção\n\n` +
    `💡 *Exemplo:*\n` +
    `/revogar joao@email.com`;

  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Comando /sync - Sincroniza status dos usuários com os grupos
bot.onText(/\/sync/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Lista de IDs de admins autorizados
  const adminIds = ['1839742847']; // SUBSTITUA pelo seu ID
  
  if (!adminIds.includes(chatId.toString())) {
    return bot.sendMessage(chatId, '❌ Você não tem permissão para usar este comando.');
  }

  bot.sendMessage(chatId, '🔄 Iniciando sincronização...');

  try {
    // Pega todos os usuários inativos que ainda têm autorização
    const result = await db.pool.query(
      `SELECT au.telegram_id, s.name, s.email
       FROM authorized_users au
       JOIN subscribers s ON au.subscriber_id = s.id
       WHERE s.status = 'inactive' AND au.authorized = true`
    );

    const inactiveUsers = result.rows;

    if (inactiveUsers.length === 0) {
      return bot.sendMessage(chatId, '✅ Nenhum usuário inativo para remover.');
    }

    // Remove de todos os canais
    const allChannels = await db.getAllChannels();
    let removedCount = 0;

    for (const user of inactiveUsers) {
      cache.invalidate(`user:tg:${user.telegram_id}`);
      cache.invalidatePattern(`membership:${user.telegram_id}:`);
      await revokeExistingInvites(user.telegram_id);

      for (const channel of allChannels) {
        try {
          await bot.banChatMember(channel.chat_id, user.telegram_id);
          await bot.unbanChatMember(channel.chat_id, user.telegram_id);
        } catch (error) {
          // Usuário pode já não estar no canal
        }
      }

      // Notifica usuário
      try {
        await bot.sendMessage(user.telegram_id,
          `⚠️ *Acesso Revogado*\n\n` +
          `Não encontramos uma assinatura ativa vinculada à sua conta.\n\n` +
          `Seu acesso aos canais foi removido.\n\n` +
          `Entre em contato com o suporte se precisar de ajuda.`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        // Usuário bloqueou o bot
      }

      removedCount++;
    }

    bot.sendMessage(chatId, 
      `✅ Sincronização concluída!\n\n` +
      `👥 Usuários removidos: ${removedCount}`
    );
    logger.info('sync_revoked_inactive_users', { removed_count: removedCount });

  } catch (error) {
    bot.sendMessage(chatId, `❌ Erro: ${error.message}`);
  }
});

module.exports = {
  bot,
  validateToken,
  consumeToken,
  notifyUserAuthorized
};
