// api/ai/sponsor-match-status.js — Met à jour le statut d'un match sponsor
// POST { matchId, status: 'contacted'|'dismissed'|'converted'|'new' }

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const VALID = ['new', 'contacted', 'dismissed', 'converted'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { matchId, status } = req.body;
    if (!matchId || !VALID.includes(status)) return res.status(400).json({ error: 'matchId and valid status required' });

    const { data, error } = await supabase
      .from('sponsor_matches')
      .update({ status })
      .eq('id', matchId)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;

    return res.status(200).json({ match: data });
  } catch (err) {
    console.error('Sponsor match status error:', err);
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
