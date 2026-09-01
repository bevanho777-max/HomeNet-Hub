// Credential vault — AES-256-GCM over node:crypto, no dependencies. SECURITY CRITICAL.
//
// The contract this file exists to keep:
//   - the only plaintext key material is the VAULT_KEY environment variable. It is read
//     once, used to derive an encryption key, and never written, logged or returned;
//   - a secret exists in cleartext exactly twice: in the request that stores it, and in
//     memory at the moment something decrypts it to open a connection. Nothing in
//     between — the database column holds ciphertext only;
//   - no VAULT_KEY means locked. Locked refuses writes rather than degrading to
//     plaintext, and existing ciphertext simply stays unreadable.
//
// Key derivation: scrypt(VAULT_KEY, per-install salt) -> 32 bytes, derived ONCE at
// startup and held in memory. The salt is 16 random bytes generated on first unlock and
// stored beside the ciphertext, so it travels with a restored backup.
//
// Why per-install and not per-ciphertext: a salt's job is to stop precomputation
// against a shared password, and one random salt per install already does that. Per
// ciphertext would add a ~100ms scrypt derivation to every single encrypt AND decrypt —
// paid on every connection a future collector opens — while buying nothing, since every
// ciphertext here is protected by the same passphrase anyway. The IV, which is what
// must never repeat, IS per ciphertext.
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALG = 'aes-256-gcm';
const BLOB_VERSION = 'v1';
const IV_LEN = 12;          // GCM's native nonce size
const KEY_LEN = 32;         // AES-256
export const SALT_LEN = 16;
// scrypt cost. N=16384 lands around 60-100ms on this class of hardware: slow enough to
// make a stolen database expensive to attack, fast enough for a once-per-boot derivation.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Encrypted at first unlock and re-checked at every boot. Without it, starting with the
// WRONG VAULT_KEY would look identical to starting with the right one until something
// tried to decrypt a real credential — and worse, new credentials would be written
// under the new key, leaving one database holding two generations of ciphertext that no
// single key can read.
export const VERIFIER_PLAINTEXT = 'homenet-hub vault verifier v1';

export const newSalt = () => randomBytes(SALT_LEN);

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_LEN, SCRYPT);
}

/** @returns {string} "v1.<iv>.<tag>.<ct>", all base64 */
function encryptWith(key, plaintext) {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return [BLOB_VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'),
    ct.toString('base64')].join('.');
}

function decryptWith(key, blob) {
  const parts = String(blob || '').split('.');
  if (parts.length !== 4 || parts[0] !== BLOB_VERSION) throw new Error('unrecognised ciphertext');
  const [, ivB, tagB, ctB] = parts;
  const d = createDecipheriv(ALG, key, Buffer.from(ivB, 'base64'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  // A wrong key or a tampered blob fails here, in final(), by design.
  return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
}

/**
 * Open the vault against a passphrase and the store's persisted salt/verifier.
 * Never throws: a vault that cannot open is a LOCKED vault, and the panel keeps running.
 *
 * @param {string|undefined} passphrase  process.env.VAULT_KEY
 * @param {{getMeta:()=>({salt:Buffer,verifier:string}|null), setMeta:(s,v)=>void}} store
 * @returns {{locked:boolean, reason:string|null, encrypt:Function, decrypt:Function, status:Function}}
 */
export function openVault(passphrase, store) {
  const locked = (reason) => ({
    locked: true,
    reason,
    encrypt() { throw lockedError(reason); },
    decrypt() { throw lockedError(reason); },
    status: () => ({ configured: false, reason }),
  });

  // An empty or whitespace-only VAULT_KEY is treated as absent, not as a passphrase —
  // `VAULT_KEY=` in an env file would otherwise "work" and encrypt everything under the
  // empty string.
  if (typeof passphrase !== 'string' || !passphrase.trim()) return locked('not configured');
  if (passphrase.length < 16) return locked('VAULT_KEY must be at least 16 characters');

  let key;
  try {
    const meta = store.getMeta();
    if (meta) {
      key = deriveKey(passphrase, meta.salt);
      let ok = false;
      try { ok = decryptWith(key, meta.verifier) === VERIFIER_PLAINTEXT; } catch { ok = false; }
      if (!ok) {
        key = null;
        return locked('VAULT_KEY does not match the key this vault was created with');
      }
    } else {
      // First unlock on this install: mint a salt and store the verifier under it.
      const salt = newSalt();
      key = deriveKey(passphrase, salt);
      store.setMeta(salt, encryptWith(key, VERIFIER_PLAINTEXT));
    }
  } catch (e) {
    // Deliberately does not include the exception text: it can carry key material in
    // some node versions' error paths.
    return locked('vault could not be opened');
  }

  return {
    locked: false,
    reason: null,
    encrypt: (plaintext) => encryptWith(key, plaintext),
    decrypt: (blob) => decryptWith(key, blob),
    status: () => ({ configured: true, reason: null }),
  };
}

function lockedError(reason) {
  const e = new Error(`vault not configured: ${reason}`);
  e.code = 'EVAULTLOCKED';
  return e;
}
