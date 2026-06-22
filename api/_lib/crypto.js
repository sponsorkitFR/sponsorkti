// api/_lib/crypto.js — Chiffrement symétrique pour les tokens OAuth stockés en base
//
// Les access_token / refresh_token des réseaux sociaux ne doivent JAMAIS être
// stockés en clair dans Supabase. On les chiffre avec AES-256-GCM avant
// insertion, et on les déchiffre seulement côté serveur au moment de l'usage.
//
// Nécessite la variable d'environnement TOKEN_ENCRYPTION_KEY — une chaîne
// aléatoire de 32 octets encodée en hex (génère-la avec :
//   openssl rand -hex 32
// ). Si elle change, tous les tokens déjà stockés deviennent indéchiffrables
// (les utilisateurs devront reconnecter leurs comptes) — ne la perds pas,
// ne la commit jamais dans Git.

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY manquante ou invalide. Génère-la avec: openssl rand -hex 32');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptToken(plainText) {
  if (!plainText) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format stocké : iv:authTag:ciphertext, tout en base64, séparé par ':'
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptToken(stored) {
  if (!stored) return null;
  const key = getKey();
  const [ivB64, tagB64, dataB64] = stored.split(':');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}
