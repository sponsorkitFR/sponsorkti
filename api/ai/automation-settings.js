// api/ai/automation-settings.js — Paramètres d'automatisation par utilisateur
// GET  : retourne les paramètres (crée une ligne par défaut si absente)
// POST : met à jour un ou plusieurs paramètres

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const DEFAULTS = {
  auto_followup: false,
  auto_followup_days: 7,
  auto_pricing_alert: true,
  auto_sponsor_scan: false,
  auto_deal_detection: false,
  auto_payment_tracking: true,
  auto_weekly_report: false,
  auto_deadline_alerts: true,
  auto_negotiation_tips: false,
  auto_memory_learning: true
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('automation_settings')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;

      if (!data) {
        const { data: created, error: insErr } = await supabase
          .from('automation_settings')
          .insert({ user_id: userId, ...DEFAULTS })
          .select()
          .single();
        if (insErr) throw insErr;
        return res.status(200).json({ settings: created });
      }
      return res.status(200).json({ settings: data });
    }

    if (req.method === 'POST') {
      const updates = {};
      for (const key of Object.keys(DEFAULTS)) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid settings provided' });
      updates.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from('automation_settings')
        .upsert({ user_id: userId, ...DEFAULTS, ...updates }, { onConflict: 'user_id' })
        .select()
        .single();
      if (error) throw error;
      return res.status(200).json({ settings: data });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Automation settings error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function getUserId(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}
