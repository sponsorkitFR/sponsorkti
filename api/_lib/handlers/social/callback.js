// api/social/callback.js — Reçoit le retour OAuth de YouTube/Instagram/TikTok,
// échange le code contre un access_token, le chiffre, le stocke, puis déclenche
// une première synchronisation des stats.

import { createClient } from '@supabase/supabase-js';
import { encryptToken } from '../../crypto.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  const { provider, code, state, error: oauthError } = req.query;
  const appUrl = process.env.PUBLIC_BASE_URL || process.env.APP_URL;
  const redirectBack = (status, msg = '') =>
    res.redirect(302, `${appUrl}/index.html?social_connect=${status}&provider=${provider}${msg ? '&msg=' + encodeURIComponent(msg) : ''}`);

  if (oauthError) return redirectBack('error', oauthError);
  if (!code || !state || !provider) return redirectBack('error', 'missing_params');

  const userId = state; // l'user_id a été passé dans `state` lors de connect.js

  try {
    if (provider === 'youtube') await handleYouTube(userId, code, appUrl);
    else if (provider === 'instagram') await handleInstagram(userId, code, appUrl);
    else if (provider === 'tiktok') await handleTikTok(userId, code, appUrl);
    else return redirectBack('error', 'unknown_provider');

    return redirectBack('success');
  } catch (e) {
    console.error(`OAuth callback error (${provider}):`, e);
    return redirectBack('error', e.message?.slice(0, 100) || 'unknown_error');
  }
}

// ── YOUTUBE ──────────────────────────────────────────────────────────
async function handleYouTube(userId, code, appUrl) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${appUrl}/api/social/callback?provider=youtube`,
      grant_type: 'authorization_code'
    })
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(tokens.error_description || 'YouTube token exchange failed');

  // Récupère la chaîne du créateur connecté (mine=true => celle liée au token)
  const chRes = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  );
  const chData = await chRes.json();
  if (!chRes.ok) throw new Error(chData.error?.message || 'YouTube channel fetch failed');
  const channel = chData.items?.[0];
  if (!channel) throw new Error('Aucune chaîne YouTube trouvée pour ce compte Google.');

  await saveConnection(userId, 'youtube', {
    provider_user_id: channel.id,
    handle: channel.snippet?.title || '',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token, // peut être absent si déjà autorisé avant (prompt=consent force normalement sa présence)
    expires_in: tokens.expires_in
  });

  await syncYouTubeStats(userId, channel.id, tokens.access_token);
}

// ── INSTAGRAM ────────────────────────────────────────────────────────
async function handleInstagram(userId, code, appUrl) {
  const tokenRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token?' + new URLSearchParams({
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri: `${appUrl}/api/social/callback?provider=instagram`,
    code
  }));
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(tokens.error?.message || 'Instagram token exchange failed');

  // Échange le token court contre un token longue durée (~60 jours)
  const longRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token?' + new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: tokens.access_token
  }));
  const longTokens = await longRes.json();
  const accessToken = longTokens.access_token || tokens.access_token;

  // Trouve la Page Facebook liée, puis le compte Instagram Business associé
  const pagesRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${accessToken}`);
  const pagesData = await pagesRes.json();
  const page = pagesData.data?.[0];
  if (!page) throw new Error('Aucune Page Facebook liée à un compte Instagram Business trouvée.');

  const igRes = await fetch(`https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${accessToken}`);
  const igData = await igRes.json();
  const igAccountId = igData.instagram_business_account?.id;
  if (!igAccountId) throw new Error('Aucun compte Instagram Business associé à cette Page.');

  const profileRes = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}?fields=username,followers_count,media_count&access_token=${accessToken}`);
  const profile = await profileRes.json();

  await saveConnection(userId, 'instagram', {
    provider_user_id: igAccountId,
    handle: profile.username || '',
    access_token: accessToken,
    refresh_token: null, // Meta utilise des tokens longue durée renouvelables, pas de refresh_token classique
    expires_in: longTokens.expires_in || 60 * 24 * 3600 // ~60 jours par défaut
  });

  await syncInstagramStats(userId, igAccountId, accessToken);
}

// ── TIKTOK ───────────────────────────────────────────────────────────
async function handleTikTok(userId, code, appUrl) {
  const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${appUrl}/api/social/callback?provider=tiktok`
    })
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || tokens.error) throw new Error(tokens.error_description || 'TikTok token exchange failed');

  await saveConnection(userId, 'tiktok', {
    provider_user_id: tokens.open_id,
    handle: '', // récupéré ensuite via user.info.basic
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in
  });

  await syncTikTokStats(userId, tokens.access_token, tokens.open_id);
}

// ── Helper commun : sauvegarde chiffrée d'une connexion ────────────────
async function saveConnection(userId, provider, { provider_user_id, handle, access_token, refresh_token, expires_in }) {
  const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000).toISOString() : null;
  const { error } = await supabase.from('social_connections').upsert({
    user_id: userId,
    provider,
    provider_user_id,
    handle,
    access_token: encryptToken(access_token),
    refresh_token: refresh_token ? encryptToken(refresh_token) : null,
    token_expires_at: expiresAt,
    connected_at: new Date().toISOString()
  }, { onConflict: 'user_id,provider' });
  if (error) throw new Error('DB save failed: ' + error.message);
}

// Ces trois fonctions de synchronisation sont aussi exportées pour être
// réutilisées par api/social/sync.js (resynchronisation manuelle ou via cron)
export async function syncYouTubeStats(userId, channelId, accessToken) {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'YouTube stats fetch failed');
  const stats = data.items?.[0]?.statistics;
  if (!stats) throw new Error('Aucune statistique YouTube retournée.');

  const subscribers = parseInt(stats.subscriberCount || '0', 10);
  const totalViews = parseInt(stats.viewCount || '0', 10);
  const videoCount = parseInt(stats.videoCount || '1', 10);
  const avgViews = videoCount > 0 ? Math.round(totalViews / videoCount) : 0;
  // YouTube Data API ne donne pas l'engagement rate directement (nécessite
  // YouTube Analytics API avec accès par vidéo) — on estime grossièrement
  // une fourchette par défaut si non calculable, à affiner avec yt-analytics plus tard.
  const engagementRate = null;

  await recordStats(userId, 'youtube', { subscribers, avg_views: avgViews, engagement_rate: engagementRate, total_posts: videoCount });
  return { subscribers, avg_views: avgViews, engagement_rate: engagementRate };
}

export async function syncInstagramStats(userId, igAccountId, accessToken) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}?fields=followers_count,media_count&access_token=${accessToken}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Instagram stats fetch failed');

  // Engagement estimé sur les ~10 derniers posts (likes+comments / followers)
  let engagementRate = null;
  try {
    const mediaRes = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}/media?fields=like_count,comments_count&limit=10&access_token=${accessToken}`);
    const mediaData = await mediaRes.json();
    const posts = mediaData.data || [];
    if (posts.length > 0 && data.followers_count) {
      const totalEngagement = posts.reduce((s, p) => s + (p.like_count || 0) + (p.comments_count || 0), 0);
      engagementRate = +((totalEngagement / posts.length / data.followers_count) * 100).toFixed(2);
    }
  } catch (e) { /* non bloquant — l'engagement reste null si indisponible */ }

  await recordStats(userId, 'instagram', { subscribers: data.followers_count || 0, avg_views: null, engagement_rate: engagementRate, total_posts: data.media_count || 0 });
  return { subscribers: data.followers_count || 0, engagement_rate: engagementRate };
}

export async function syncTikTokStats(userId, accessToken, openId) {
  const res = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,follower_count,video_count,likes_count', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  if (!res.ok || data.error?.code !== 'ok') throw new Error(data.error?.message || 'TikTok stats fetch failed');
  const user = data.data?.user || {};

  // Met à jour le handle maintenant qu'on l'a (absent au moment du saveConnection initial)
  if (user.display_name) {
    await supabase.from('social_connections').update({ handle: user.display_name }).eq('user_id', userId).eq('provider', 'tiktok');
  }

  const engagementRate = user.follower_count > 0 && user.video_count > 0
    ? +((user.likes_count / user.video_count / user.follower_count) * 100).toFixed(2)
    : null;

  await recordStats(userId, 'tiktok', { subscribers: user.follower_count || 0, avg_views: null, engagement_rate: engagementRate, total_posts: user.video_count || 0 });
  return { subscribers: user.follower_count || 0, engagement_rate: engagementRate };
}

async function recordStats(userId, provider, { subscribers, avg_views, engagement_rate, total_posts }) {
  await supabase.from('social_stats_history').insert({
    user_id: userId, provider, subscribers, avg_views, engagement_rate, total_posts
  });

  // Met à jour le snapshot "officiel" du profil UNIQUEMENT si c'est la
  // plateforme déjà désignée comme source, ou s'il n'y en a pas encore.
  const { data: profile } = await supabase.from('profiles').select('verified_provider').eq('id', userId).single();
  if (!profile?.verified_provider || profile.verified_provider === provider) {
    await supabase.from('profiles').update({
      verified_provider: provider,
      verified_subscribers: subscribers,
      verified_engagement_rate: engagement_rate,
      verified_avg_views: avg_views,
      verified_at: new Date().toISOString(),
      // On synchronise aussi les champs "affichés" historiques pour que tout
      // le reste du site (pricing, dashboard) bénéficie immédiatement des vraies données
      subscribers, engagement_rate: engagement_rate ?? undefined, avg_views: avg_views ?? undefined
    }).eq('id', userId);
  }

  await supabase.from('social_connections').update({
    last_sync: new Date().toISOString(), last_sync_status: 'success', last_sync_error: null
  }).eq('user_id', userId).eq('provider', provider);
}
