require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

// Substitua pelos usernames dos canais (se tiverem) ou pelos links
const channels = [
  '@seu_canal_1',  // Substitua pelo @ do canal ou username
  '@seu_canal_2',
  '@seu_canal_3'
];

async function getChatIds() {
  console.log('🔍 Buscando informações dos canais...\n');
  
  for (const channel of channels) {
    try {
      const chat = await bot.getChat(channel);
      console.log('═══════════════════════════════════════');
      console.log(`📱 Nome: ${chat.title}`);
      console.log(`🆔 Chat ID: ${chat.id}`);
      console.log(`📂 Tipo: ${chat.type}`);
      console.log('═══════════════════════════════════════\n');
    } catch (error) {
      console.error(`❌ Erro ao buscar ${channel}:`, error.message);
    }
  }
  
  process.exit();
}

getChatIds();