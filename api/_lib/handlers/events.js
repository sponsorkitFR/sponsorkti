// api/events.js — Enregistre les événements analytics dans Supabase

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST — enregistrer un événement
  if (req.method === 'POST') {
    try {
      const { type, data } = req.body;

      // Récupérer IP et infos navigateur
      const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
      const ua = req.headers['user-agent'] || '';
      const lang = req.headers['accept-language']?.slice(0, 2) || 'fr';

      const payload = {
        type,           // 'pageview' | 'consent' | 'chat' | 'pitch' | 'session'
        data,           // objet libre selon le type
        ip_hash: await hashIP(ip), // on hash l'IP pour la vie privée
        user_agent: ua.slice(0, 200),
        lang,
        is_mobile: /Mobile|Android|iPhone|iPad/.test(ua),
        created_at: new Date().toISOString()
      };

      const { error } = await supabase.from('events').insert(payload);
      if (error) throw error;

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Events POST error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Hash l'IP pour conformité RGPD (pas de données personnelles stockées)
async function hashIP(ip) {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + process.env.IP_SALT || 'sponsorkit-salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
