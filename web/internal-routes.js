const crypto = require('crypto');
const express = require('express');
const db = require('./database');
const logger = require('../shared/logger');
const { sanitizeEmail, sanitizeText } = require('../shared/sanitize');

const INTERNAL_SECRET_HEADER = 'x-internal-secret';

function timingSafeSecretMatches(providedSecret, expectedSecret) {
  if (typeof providedSecret !== 'string' || typeof expectedSecret !== 'string') {
    return false;
  }

  const provided = Buffer.from(providedSecret);
  const expected = Buffer.from(expectedSecret);

  if (provided.length !== expected.length) {
    crypto.timingSafeEqual(expected, expected);
    return false;
  }

  return crypto.timingSafeEqual(provided, expected);
}

function maskEmail(email) {
  const [localPart, domain] = String(email || '').split('@');

  if (!localPart || !domain) {
    return email;
  }

  const visible = localPart.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(localPart.length - visible.length, 1))}@${domain}`;
}

function createInternalRouter() {
  const router = express.Router();

  router.post('/revoke', async (req, res) => {
    const configuredSecret = process.env.INTERNAL_API_SECRET;

    if (!configuredSecret) {
      logger.warn('internal_revoke_secret_not_configured');
      return res.status(503).json({ status: 'error', message: 'Internal API secret not configured' });
    }

    const providedSecret = req.get(INTERNAL_SECRET_HEADER);

    if (!timingSafeSecretMatches(providedSecret, configuredSecret)) {
      logger.warn('internal_revoke_unauthorized', { ip: req.ip || req.socket.remoteAddress || 'unknown' });
      return res.status(401).json({ status: 'unauthorized' });
    }

    const email = sanitizeEmail(req.body?.email);
    const reason = sanitizeText(req.body?.reason || '', 80);
    const maskedEmail = maskEmail(email);

    if (!email) {
      logger.info('internal_revoke_bad_request', { reason });
      return res.status(400).json({ status: 'error', message: 'email is required' });
    }

    logger.info('internal_revoke_requested', { email: maskedEmail, reason });

    try {
      const subscriber = await db.getSubscriberByEmail(email);

      if (!subscriber) {
        logger.info('internal_revoke_not_found', { email: maskedEmail, reason });
        return res.json({ status: 'not_found', email });
      }

      const authorizedUsers = await db.getAuthorizedUsersBySubscriberId(subscriber.id);
      const linkedUsers = authorizedUsers.filter((user) => user.telegram_id);
      const activeLinkedUsers = linkedUsers.filter((user) => user.authorized !== false);

      if (linkedUsers.length === 0) {
        logger.info('internal_revoke_no_telegram_link', { email: maskedEmail, reason });
        return res.json({
          status: 'no_telegram_link',
          email,
          telegram_id_encontrado: false,
          canais_processados: 0,
          falhas: []
        });
      }

      if (activeLinkedUsers.length === 0) {
        logger.info('internal_revoke_already_revoked', {
          email: maskedEmail,
          reason,
          telegram_ids: linkedUsers.length
        });

        return res.json({
          status: 'already_revoked',
          email,
          telegram_id_encontrado: true,
          canais_processados: 0,
          falhas: []
        });
      }

      const revocations = await Promise.all(activeLinkedUsers.map((user) => db.revokeAuthorization(user.telegram_id)));
      const failures = revocations.flatMap((revocation) => revocation.failures || []);
      const channelsProcessed = revocations.reduce(
        (total, revocation) => total + (revocation.channels_processed || 0),
        0
      );

      logger.info('internal_revoke_completed', {
        email: maskedEmail,
        reason,
        status: 'revoked',
        telegram_id_found: true,
        telegram_ids: linkedUsers.length,
        revoked_telegram_ids: activeLinkedUsers.length,
        channels_processed: channelsProcessed,
        failures: failures.length
      });

      return res.json({
        status: 'revoked',
        email,
        telegram_id_encontrado: true,
        canais_processados: channelsProcessed,
        falhas: failures
      });
    } catch (error) {
      logger.error('internal_revoke_error', {
        email: maskedEmail,
        reason,
        error: error.message,
        stack: error.stack
      });

      return res.status(500).json({ status: 'error', message: error.message });
    }
  });

  return router;
}

module.exports = { createInternalRouter, timingSafeSecretMatches };
