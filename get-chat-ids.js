require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

console.log('🤖 Bot iniciado! Envie uma mensagem em cada grupo/canal onde o bot é admin.\n');

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const chatTitle = msg.chat.title || 'Chat Privado';
  const chatType = msg.chat.type;
  
  console.log('═══════════════════════════════════════');
  console.log(`📱 Nome: ${chatTitle}`);
  console.log(`🆔 Chat ID: ${chatId}`);
  console.log(`📂 Tipo: ${chatType}`);
  console.log('═══════════════════════════════════════\n');
});

console.log('Aguardando mensagens...');