require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('../web/database');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

// Lista de todos os chat_ids dos grupos/canais
const chatIds = [
  '-1001677560234',  // Bate-Papo 1
  '-1001854290732',  // Bate-Papo 2
  '-1001770950182',  // Bate-Papo 3
  '-1001662496741',  // Milhas
  '-1001848040585',  // Atualizações CF VIP
  '-1001696501981',  // Atualizações CF LITE
  '-1002037275118'   // Projeto Renda Passiva
];

async function syncMembers() {
  console.log('🔄 Iniciando sincronização de membros...\n');

  for (const chatId of chatIds) {
    try {
      const chat = await bot.getChat(chatId);
      console.log(`\n📱 Verificando: ${chat.title}`);

      // Pega total de membros (aproximado)
      const memberCount = await bot.getChatMemberCount(chatId);
      console.log(`👥 Total de membros: ${memberCount}`);

      // Verifica membros um por um (apenas para grupos pequenos)
      // Para grupos grandes, isso pode ser lento
      
      let removedCount = 0;

      // Aqui verificamos apenas usuários que foram autorizados anteriormente
      const allAuthorized = await db.getAllAuthorizedUsers();

      for (const user of allAuthorized) {
        try {
          // Verifica se o usuário ainda está no grupo
          const member = await bot.getChatMember(chatId, user.telegram_id);
          
          // Se encontrou o membro no grupo
          if (member.status !== 'left' && member.status !== 'kicked') {
            // Verifica se ainda está autorizado no banco
            const stillAuthorized = await db.getUserByTelegramId(user.telegram_id);
            
            if (!stillAuthorized || !stillAuthorized.authorized) {
              // Não está mais autorizado - REMOVE!
              await bot.banChatMember(chatId, user.telegram_id);
              await bot.unbanChatMember(chatId, user.telegram_id);
              
              console.log(`  ❌ Removido: ${user.name || user.telegram_id}`);
              removedCount++;

              // Notifica o usuário
              try {
                await bot.sendMessage(user.telegram_id,
                  `⚠️ *Acesso Revogado*\n\n` +
                  `Não encontramos uma assinatura ativa vinculada à sua conta.\n\n` +
                  `Seu acesso aos canais exclusivos foi removido.\n\n` +
                  `Se você acredita que isso é um erro, entre em contato com o suporte.`,
                  { parse_mode: 'Markdown' }
                );
              } catch (msgError) {
                // Usuário bloqueou o bot
              }

              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        } catch (error) {
          // Usuário não está no grupo ou erro ao verificar
          if (error.response && error.response.body.error_code === 400) {
            // Usuário não está no grupo - OK
          } else {
            console.error(`  ⚠️ Erro ao verificar membro:`, error.message);
          }
        }
      }

      console.log(`  ✅ Removidos: ${removedCount}`);

    } catch (error) {
      console.error(`❌ Erro ao processar ${chatId}:`, error.message);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n✅ Sincronização concluída!\n');
  process.exit(0);
}

syncMembers();