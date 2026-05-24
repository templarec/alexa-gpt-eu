const crypto = require("crypto");

const ENCRYPTION_PREFIX = "enc:v1";
const ALGORITHM = "aes-256-gcm";

function getEncryptionKey() {
  const key = process.env.BODY_ENCRYPTION_KEY;

  if (!key) {
    throw new Error("BODY_ENCRYPTION_KEY is not configured");
  }

  const buffer = Buffer.from(key, "base64");

  if (buffer.length !== 32) {
    throw new Error("BODY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  return buffer;
}

function isEncryptedValue(value) {
  return typeof value === "string" && value.startsWith(`${ENCRYPTION_PREFIX}:`);
}

function encryptValue(value) {
  if (value === null || value === undefined || value === "") {
    return value;
  }

  if (isEncryptedValue(value)) {
    return value;
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = String(value);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTION_PREFIX,
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decryptValue(value) {
  if (!isEncryptedValue(value)) {
    return value;
  }

  const parts = value.split(":");

  if (parts.length !== 5) {
    throw new Error("Invalid encrypted value format");
  }

  const [, , ivBase64, authTagBase64, encryptedBase64] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivBase64, "base64");
  const authTag = Buffer.from(authTagBase64, "base64");
  const encrypted = Buffer.from(encryptedBase64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

function normalizeUserId(userId) {
  return String(userId || process.env.DEFAULT_USER_ID || "lorenzo")
    .trim()
    .toLowerCase();
}

function getEncryptedBodyUserIds() {
  const raw = String(process.env.ENCRYPTED_BODY_USER_IDS || "elisa").trim();

  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function shouldEncryptBodyForUser(userId) {
  return getEncryptedBodyUserIds().includes(normalizeUserId(userId));
}

function maybeEncryptBodyValue(userId, value) {
  if (!shouldEncryptBodyForUser(userId)) {
    return value;
  }

  return encryptValue(value);
}

function maybeDecryptBodyValue(value) {
  return decryptValue(value);
}

function maybeDecryptBodyNumber(value) {
  const decrypted = maybeDecryptBodyValue(value);

  if (decrypted === null || decrypted === undefined || decrypted === "") {
    return null;
  }

  const normalized = String(decrypted).replace(",", ".");
  const number = Number(normalized);

  return Number.isFinite(number) ? number : null;
}

module.exports = {
  ENCRYPTION_PREFIX,
  isEncryptedValue,
  encryptValue,
  decryptValue,
  shouldEncryptBodyForUser,
  maybeEncryptBodyValue,
  maybeDecryptBodyValue,
  maybeDecryptBodyNumber,
};
