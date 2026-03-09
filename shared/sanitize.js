function sanitizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.toLowerCase().trim().substring(0, 255);
}

function sanitizeText(text, maxLength = 255) {
  if (typeof text !== 'string') return '';
  return text.trim().substring(0, maxLength);
}

function sanitizeNumericId(id) {
  const num = Number(id);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

module.exports = { sanitizeEmail, sanitizeText, sanitizeNumericId };
