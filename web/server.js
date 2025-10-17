const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const db = require('./database');
const { validateToken, consumeToken, notifyUserAuthorized } = require('../bot/index');
const hotmartWebhook = require('./hotmart-webhook');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS - Permite requisições da Vercel
const cors = require('cors');
app.use(cors({
  origin: '*',
  credentials: true
}));

// Webhook Hotmart (usa body raw, precisa vir antes do bodyParser padrão)
app.use('/api/hotmart/webhook', hotmartWebhook);

// Middleware
app.use(bodyParser.json({ limit: '15mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Armazena tentativas de verificação (anti-fraude)
const verificationAttempts = new Map();

// Rota principal - Página de verificação
app.get('/verify', (req, res) => {
  const token = req.query.token;
  
  if (!token) {
    return res.status(400).send('Token inválido');
  }

  const tokenData = validateToken(token);
  
  if (!tokenData) {
    return res.sendFile(path.join(__dirname, 'public', 'expired.html'));
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota de verificação de dados
app.post('/api/verify', async (req, res) => {
  const { token, email, phone } = req.body;
  const sanitizedEmail = typeof email === 'string' ? email.trim() : '';
  const sanitizedPhone = typeof phone === 'string' ? phone : '';

  // Validação básica
  if (!token || !sanitizedEmail || !sanitizedPhone) {
    return res.status(400).json({ 
      success: false, 
      message: 'Preencha todos os campos obrigatórios' 
    });
  }

  // Valida formato do email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(sanitizedEmail)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Email inválido' 
    });
  }

  // Normaliza telefone removendo caracteres não numéricos
  const phoneClean = sanitizedPhone.replace(/\D/g, '');
  // Permite telefones internacionais com tamanho variável
  if (phoneClean.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'Telefone inválido. Informe o número completo com DDD/DDI.'
    });
  }

  // Valida token
  const tokenData = validateToken(token);
  
  if (!tokenData) {
    return res.status(401).json({ 
      success: false, 
      message: 'Link expirado ou inválido. Solicite um novo link no bot.' 
    });
  }

  // Anti-fraude: Limita tentativas
  const attempts = verificationAttempts.get(tokenData.telegramId) || 0;
  
  if (attempts >= 5) {
    return res.status(429).json({ 
      success: false, 
      message: 'Muitas tentativas. Entre em contato com o suporte.' 
    });
  }

  try {
    // Verifica no banco de dados
    const subscriber = await db.getSubscriberByEmailAndPhone(sanitizedEmail, phoneClean);

    if (!subscriber) {
      // Incrementa tentativas
      verificationAttempts.set(tokenData.telegramId, attempts + 1);
      
      return res.status(404).json({ 
        success: false, 
        message: 'Dados não encontrados. Verifique se você é um assinante ativo.' 
      });
    }

    // Sucesso! Autoriza usuário
    await db.authorizeUser(tokenData.telegramId, subscriber);

    // Consome o token (impede reutilização)
    consumeToken(token);

    // Limpa tentativas
    verificationAttempts.delete(tokenData.telegramId);

    // Notifica usuário no Telegram
    await notifyUserAuthorized(tokenData.telegramId, subscriber);

    res.json({ 
      success: true, 
      message: 'Verificação concluída! Verifique seu Telegram.',
      plan: subscriber.plan
    });

  } catch (error) {
    console.error('Erro na verificação:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro no servidor. Tente novamente.' 
    });
  }
});

// Rota para verificar status do token (opcional)
app.get('/api/check-token', (req, res) => {
  const token = req.query.token;
  const tokenData = validateToken(token);
  
  res.json({ 
    valid: !!tokenData,
    expiresIn: tokenData ? Math.floor((tokenData.expires - Date.now()) / 1000) : 0
  });
});

// Limpa tentativas antigas a cada hora
setInterval(() => {
  verificationAttempts.clear();
}, 60 * 60 * 1000);

// Rotas administrativas
const adminRoutes = require('./admin-routes');
app.use('/api/admin', adminRoutes);

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Acesse: http://localhost:${PORT}`);
});

module.exports = app;