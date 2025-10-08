require('dotenv').config();

// Inicia o bot do Telegram
require('./bot/index');

// Inicia o servidor web
require('./web/server');

console.log('🤖 Bot do Telegram iniciado!');
console.log('🌐 Servidor web rodando!');
console.log('✅ Sistema pronto para uso!');