const crypto = require('node:crypto');

let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch (error) {
  bcrypt = null;
}

const PBKDF2_ITERATIONS = 150000;
const PBKDF2_KEY_LEN = 64;
const PBKDF2_DIGEST = 'sha512';
const PBKDF2_PREFIX = 'pbkdf2';

function pbkdf2Hash(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, PBKDF2_KEY_LEN, PBKDF2_DIGEST, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(`${PBKDF2_PREFIX}$${iterations}$${salt}$${derivedKey.toString('hex')}`);
    });
  });
}

function pbkdf2Verify(password, hash) {
  const [, iterationsStr, salt, expectedHash] = hash.split('$');
  const iterations = parseInt(iterationsStr, 10);

  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, PBKDF2_KEY_LEN, PBKDF2_DIGEST, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }

      const derivedHex = derivedKey.toString('hex');
      const expectedBuffer = Buffer.from(expectedHash, 'hex');
      const derivedBuffer = Buffer.from(derivedHex, 'hex');

      if (expectedBuffer.length !== derivedBuffer.length) {
        resolve(false);
        return;
      }

      resolve(crypto.timingSafeEqual(expectedBuffer, derivedBuffer));
    });
  });
}

async function hashPassword(password) {
  if (bcrypt) {
    return bcrypt.hash(password, 10);
  }

  return pbkdf2Hash(password);
}

async function verifyPassword(password, hash) {
  if (!hash) {
    return false;
  }

  if (hash.startsWith(`${PBKDF2_PREFIX}$`)) {
    return pbkdf2Verify(password, hash);
  }

  if (bcrypt) {
    return bcrypt.compare(password, hash);
  }

  return false;
}

module.exports = {
  hashPassword,
  verifyPassword,
  isBcryptAvailable: () => Boolean(bcrypt)
};
