class AlertManager {
  constructor() {
    this.bot = null;
    this.chatId = null;
    this.cooldowns = new Map();
    this.defaultCooldownMs = 5 * 60 * 1000;
  }

  init(bot, chatId) {
    this.bot = bot;
    this.chatId = chatId;
  }

  async send(type, message, cooldownMs) {
    if (!this.bot || !this.chatId) return;

    const cooldown = cooldownMs === 0 ? 0 : (cooldownMs || this.defaultCooldownMs);
    const lastSent = this.cooldowns.get(type);

    if (cooldown > 0 && lastSent && (Date.now() - lastSent < cooldown)) {
      return;
    }

    try {
      const text = `⚠️ *ALERTA: ${type}*\n\n${message}\n\n_${new Date().toISOString()}_`;
      await this.bot.sendMessage(this.chatId, text, { parse_mode: 'Markdown' });
      this.cooldowns.set(type, Date.now());
    } catch (_error) {
      // ALERT_CHAT_ID (opcional): ID do chat/grupo Telegram para alertas operacionais.
      // Para obter: adicione o bot ao grupo, envie uma mensagem e use
      // https://api.telegram.org/bot<TOKEN>/getUpdates para identificar o chat_id.
      // Se ausente, alertas ficam desativados silenciosamente.
    }
  }
}

module.exports = new AlertManager();
