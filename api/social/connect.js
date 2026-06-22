// api/social/connect.js — Génère les URLs OAuth pour YouTube / Instagram / TikTok
// et retourne le statut des connexions existantes de l'utilisateur.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token requis' });
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token invalide' });

  const { provider } = req.query;
  const appUrl = process.env.PUBLIC_BASE_URL || process.env.APP_URL;

  // ── YOUTUBE (Google OAuth — opérationnel immédiatement, pas de validation requise) ──
  if (provider === 'youtube') {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: 'YouTube non configuré côté serveur (GOOGLE_CLIENT_ID manquant).' });
    }
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: `${appUrl}/api/social/callback?provider=youtube`,
      response_type: 'code',
      // readonly suffit : on ne fait que lire les stats de la chaîne du créateur
      scope: [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
        'https://www.googleapis.com/auth/userinfo.profile'
      ].join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: user.id
    });
    return res.status(200).json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }

  // ── INSTAGRAM (Meta Graph API — nécessite un compte Instagram Business/Creator
  //    + une App Meta validée en mode "Live" pour fonctionner hors mode test) ──
  if (provider === 'instagram') {
    if (!process.env.META_APP_ID) {
      return res.status(503).json({ error: 'Instagram non configuré côté serveur (META_APP_ID manquant).' });
    }
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: `${appUrl}/api/social/callback?provider=instagram`,
      response_type: 'code',
      scope: [
        'instagram_basic',
        'instagram_manage_insights',
        'pages_show_list',
        'pages_read_engagement'
      ].join(','),
      state: user.id
    });
    return res.status(200).json({
      url: `https://www.facebook.com/v19.0/dialog/oauth?${params}`,
      note: 'Instagram exige un compte Business/Creator lié à une Page Facebook, et que ton App Meta soit validée (App Review) pour les scopes instagram_basic et instagram_manage_insights hors mode test.'
    });
  }

  // ── TIKTOK (TikTok for Developers — Login Kit + Display API,
  //    accès "stats" complet nécessite validation de l'app) ──
  if (provider === 'tiktok') {
    if (!process.env.TIKTOK_CLIENT_KEY) {
      return res.status(503).json({ error: 'TikTok non configuré côté serveur (TIKTOK_CLIENT_KEY manquant).' });
    }
    const params = new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      redirect_uri: `${appUrl}/api/social/callback?provider=tiktok`,
      response_type: 'code',
      scope: ['user.info.basic', 'user.info.stats', 'video.list'].join(','),
      state: user.id
    });
    return res.status(200).json({
      url: `https://www.tiktok.com/v2/auth/authorize?${params}`,
      note: 'Le scope user.info.stats nécessite que ton app TikTok soit approuvée (Manage apps → App review) avant de fonctionner pour des comptes hors liste de testeurs.'
    });
  }

  // ── Pas de provider précisé → retourne le statut des connexions existantes ──
  const { data, error } = await supabase
    .from('social_connections')
    .select('provider, handle, connected_at, last_sync, last_sync_status, last_sync_error')
    .eq('user_id', user.id);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ connections: data || [] });
}
