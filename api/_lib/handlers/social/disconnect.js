// api/social/disconnect.js — Supprime une connexion sociale (révoque côté SponsorKit)
// POST { provider: 'youtube' | 'instagram' | 'tiktok' }

import { createClient } from '@supabase/supabase-js';

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

  const { provider } = req.body;
  if (!['youtube', 'instagram', 'tiktok'].includes(provider)) {
    return res.status(400).json({ error: 'provider invalide' });
  }

  const { error } = await supabase.from('social_connections').delete().eq('user_id', user.id).eq('provider', provider);
  if (error) return res.status(500).json({ error: error.message });

  // Si c'était la source "vérifiée" du profil, on la retire (les champs declared restent)
  const { data: profile } = await supabase.from('profiles').select('verified_provider').eq('id', user.id).single();
  if (profile?.verified_provider === provider) {
    await supabase.from('profiles').update({
      verified_provider: null, verified_subscribers: null, verified_engagement_rate: null, verified_avg_views: null, verified_at: null
    }).eq('id', user.id);
  }

  return res.status(200).json({ ok: true });
}
