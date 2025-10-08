require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

async function getMyChats() {
  console.log('🔍 Buscando chats onde o bot é membro/admin...\n');
  
  // Lista de IDs que já sabemos (grupos)
  const knownIds = [
    '-1001662496741',  // Milhas
    '-1001770950182',  // Bate-papo 3
    '-1001854290732',  // Bate-papo 2
    '-1001677560234',  // Bate-papo 1
    '-1001848040585',  // Atualizações CF VIP (provável)
    '-1001696501981',  // Atualizações CF LITE (provável)
    '-1002037275118'   // Projeto Renda Passiva (provável)
  ];
  
  for (const chatId of knownIds) {
    try {
      const chat = await bot.getChat(chatId);
      const member = await bot.getChatMember(chatId, bot.options.polling ? (await bot.getMe()).id : token.split(':')[0]);
      
      console.log('═══════════════════════════════════════');
      console.log(`📱 Nome: ${chat.title || 'Sem nome'}`);
      console.log(`🆔 Chat ID: ${chat.id}`);
      console.log(`📂 Tipo: ${chat.type}`);
      console.log(`👤 Bot é: ${member.status}`);
      console.log('═══════════════════════════════════════\n');
    } catch (error) {
      console.log(`⚠️ ID ${chatId}: ${error.message}\n`);
    }
  }
  
  process.exit();
}

getMyChats();