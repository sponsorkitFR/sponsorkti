// api/social/sync.js — Resynchronise les stats d'une ou toutes les plateformes
// connectées. Gère le rafraîchissement des tokens expirés.
//
// POST /api/social/sync              → resync toutes les plateformes connectées de l'utilisateur
// POST /api/social/sync?provider=x   → resync uniquement cette plateforme

import { createClient } from '@supabase/supabase-js';
import { encryptToken, decryptToken } from '../_lib/crypto.js';
import { syncYouTubeStats, syncInstagramStats, syncTikTokStats } from './callback.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token requis' });
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token invalide' });

  const { provider: filterProvider } = req.query;

  let query = supabase.from('social_connections').select('*').eq('user_id', user.id);
  if (filterProvider) query = query.eq('provider', filterProvider);
  const { data: connections, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  if (!connections || connections.length === 0) {
    return res.status(404).json({ error: 'Aucune connexion sociale trouvée.' });
  }

  const results = [];
  for (const conn of connections) {
    try {
      const accessToken = await getValidAccessToken(conn);
      let stats;
      if (conn.provider === 'youtube') stats = await syncYouTubeStats(user.id, conn.provider_user_id, accessToken);
      else if (conn.provider === 'instagram') stats = await syncInstagramStats(user.id, conn.provider_user_id, accessToken);
      else if (conn.provider === 'tiktok') stats = await syncTikTokStats(user.id, accessToken, conn.provider_user_id);
      results.push({ provider: conn.provider, status: 'success', stats });
    } catch (e) {
      console.error(`Sync error (${conn.provider}):`, e);
      await supabase.from('social_connections').update({
        last_sync: new Date().toISOString(), last_sync_status: 'error', last_sync_error: e.message?.slice(0, 200)
      }).eq('user_id', user.id).eq('provider', conn.provider);
      results.push({ provider: conn.provider, status: 'error', error: e.message });
    }
  }

  return res.status(200).json({ results });
}

// Vérifie l'expiration et rafraîchit le token si nécessaire avant de l'utiliser
async function getValidAccessToken(conn) {
  const accessToken = decryptToken(conn.access_token);
  const isExpired = conn.token_expires_at && new Date(conn.token_expires_at) <= new Date(Date.now() + 60_000); // marge de 1min

  if (!isExpired) return accessToken;
  if (!conn.refresh_token) {
    // Pas de refresh_token disponible (cas Instagram notamment) — le token
    // doit être manuellement reconnecté par l'utilisateur une fois expiré.
    throw new Error('Token expiré et non renouvelable automatiquement — reconnecte ce compte.');
  }

  const refreshToken = decryptToken(conn.refresh_token);
  let newTokens;

  if (conn.provider === 'youtube') {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });
    newTokens = await r.json();
    if (!r.ok) throw new Error(newTokens.error_description || 'YouTube token refresh failed');
  } else if (conn.provider === 'tiktok') {
    const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });
    newTokens = await r.json();
    if (!r.ok || newTokens.error) throw new Error(newTokens.error_description || 'TikTok token refresh failed');
  } else {
    throw new Error(`Refresh non supporté pour ${conn.provider}`);
  }

  const expiresAt = newTokens.expires_in ? new Date(Date.now() + newTokens.expires_in * 1000).toISOString() : null;
  await supabase.from('social_connections').update({
    access_token: encryptToken(newTokens.access_token),
    refresh_token: newTokens.refresh_token ? encryptToken(newTokens.refresh_token) : conn.refresh_token,
    token_expires_at: expiresAt
  }).eq('id', conn.id);

  return newTokens.access_token;
}
