// Decide o que fazer com um pedido de entrada (chat_join_request).
//
// Isolado do bot/index.js de propósito: a regra é pura (sem token, sem banco),
// então dá para testá-la sem subir o bot.
//
// Só existem duas saídas: aprovar, ou deixar o pedido pendente. Nunca recusar
// automaticamente — um comprador cujo webhook da Hotmart ainda não chegou seria
// recusado à toa. Pendente, ele continua na fila e um admin decide pelo próprio
// Telegram.
function decideJoinRequest(user, channels, chatId) {
  const chatIdStr = String(chatId ?? '').trim();

  if (!chatIdStr) {
    return { approve: false, reason: 'missing_chat_id' };
  }

  if (!user) {
    return { approve: false, reason: 'unknown_user' };
  }

  if (!user.authorized) {
    return { approve: false, reason: 'not_authorized' };
  }

  // Assinante inativo/suspenso não entra: é justamente quem o /sync remove
  // dos canais depois.
  if (user.status !== 'active') {
    return { approve: false, reason: 'subscriber_not_active' };
  }

  const channel = (channels || []).find(
    (item) => item && String(item.chat_id ?? '').trim() === chatIdStr
  );

  // O canal precisa estar entre os do plano do usuário. Sem esta checagem,
  // qualquer autorizado entraria em qualquer canal.
  if (!channel) {
    return { approve: false, reason: 'channel_not_in_plan' };
  }

  return { approve: true, reason: 'authorized', channel };
}

module.exports = { decideJoinRequest };
