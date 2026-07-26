import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

/**
 * Encrypts device credentials (SSH/Telnet passwords, SNMP community strings
 * and v3 auth/priv passphrases, enable secrets, API tokens) at rest.
 *
 * The key comes from the required CREDENTIAL_ENC_KEY env var (64 hex chars =
 * 32 bytes) and boot fails loudly if it's missing or malformed — deliberately
 * following the lesson from AUDIT-REPORT.md C1 (the JWT secret silently
 * defaulting to a public value was a complete auth bypass). There is no
 * fallback here; an unset key is a configuration error, not a dev
 * convenience to paper over.
 */
@Injectable()
export class CredentialEncryptionService implements OnModuleInit {
  private key!: Buffer;

  onModuleInit() {
    const raw = process.env.CREDENTIAL_ENC_KEY;
    if (!raw) {
      throw new Error(
        'CREDENTIAL_ENC_KEY is not set. Device credentials cannot be encrypted at rest ' +
          'without it. Generate one with `openssl rand -hex 32` and set it in the environment ' +
          '(see .env.example) — refusing to boot rather than silently storing plaintext.',
      );
    }
    const key = Buffer.from(raw, 'hex');
    if (key.length !== 32) {
      throw new Error(
        `CREDENTIAL_ENC_KEY must decode to exactly 32 bytes (64 hex chars); got ${key.length}. ` +
          'Generate one with `openssl rand -hex 32`.',
      );
    }
    this.key = key;
  }

  /** Returns iv(12) || ciphertext || authTag(16), suitable for device_credentials.secret_encrypted. */
  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, ciphertext, authTag]);
  }

  decrypt(blob: Buffer): string {
    if (blob.length < IV_LEN + AUTH_TAG_LEN) {
      throw new Error('Malformed credential ciphertext (too short)');
    }
    const iv = blob.subarray(0, IV_LEN);
    const authTag = blob.subarray(blob.length - AUTH_TAG_LEN);
    const ciphertext = blob.subarray(IV_LEN, blob.length - AUTH_TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
