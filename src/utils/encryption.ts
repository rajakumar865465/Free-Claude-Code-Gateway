import * as crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

/**
 * Get encryption key from environment or generate a temporary one.
 * WARNING: Without ENCRYPTION_KEY env var, secrets won't persist across restarts.
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (key) {
    // Ensure key is exactly 32 bytes
    const keyBuffer = Buffer.from(key, 'hex');
    if (keyBuffer.length !== KEY_LENGTH) {
      throw new Error(`ENCRYPTION_KEY must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes)`);
    }
    return keyBuffer;
  }
  
  // Generate temporary key and warn
  const generated = crypto.randomBytes(KEY_LENGTH);
  console.warn('⚠️  WARNING: No ENCRYPTION_KEY environment variable set.');
  console.warn('⚠️  Encrypted secrets will not persist across server restarts.');
  console.warn(`⚠️  Generate a key with: node -e "console.log(crypto.randomBytes(32).toString('hex'))"`);
  return generated;
}

/**
 * Encrypt sensitive text using AES-256-GCM.
 * Returns format: iv:authTag:encrypted
 */
export function encrypt(text: string): string {
  if (!text || text.trim().length === 0) {
    return '';
  }
  
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Format: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt text encrypted with encrypt().
 * Expects format: iv:authTag:encrypted
 */
export function decrypt(encrypted: string): string {
  if (!encrypted || encrypted.trim().length === 0) {
    return '';
  }
  
  const key = getEncryptionKey();
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format. Expected iv:authTag:encrypted');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Check if a string appears to be encrypted (has the expected format)
 */
export function isEncrypted(text: string): boolean {
  if (!text) return false;
  const parts = text.split(':');
  return parts.length === 3 && parts.every(p => /^[0-9a-f]+$/i.test(p));
}
