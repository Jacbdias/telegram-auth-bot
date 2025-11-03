function normalizePhone(phone) {
  if (!phone) {
    return '';
  }

  return String(phone).replace(/\D/g, '');
}

function stripLeadingZeros(phone) {
  if (!phone) {
    return '';
  }

  const withoutZeros = phone.replace(/^0+/, '');
  return withoutZeros.length > 0 ? withoutZeros : phone;
}

function buildVariants(phone) {
  const normalized = normalizePhone(phone);

  if (!normalized) {
    return [];
  }

  const variants = new Set([normalized]);
  const trimmed = stripLeadingZeros(normalized);
  variants.add(trimmed);

  return Array.from(variants);
}

function phonesMatch(phoneA, phoneB, minLength = 6) {
  const variantsA = buildVariants(phoneA);
  const variantsB = buildVariants(phoneB);

  if (variantsA.length === 0 || variantsB.length === 0) {
    return false;
  }

  for (const candidate of variantsA) {
    for (const target of variantsB) {
      if (candidate === target) {
        return true;
      }

      if (candidate.length >= minLength && target.length >= minLength) {
        if (candidate.endsWith(target) || target.endsWith(candidate)) {
          return true;
        }

        const candidateSuffix = candidate.slice(-minLength);
        const targetSuffix = target.slice(-minLength);

        if (candidateSuffix === targetSuffix) {
          return true;
        }
      }
    }
  }

  return false;
}

module.exports = {
  normalizePhone,
  phonesMatch
};
