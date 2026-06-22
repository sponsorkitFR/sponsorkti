// api/brand/team.js — Gestion équipe marketing
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = req.headers.authorization?.replace('Bearer ','');
  const { data:{ user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error:'Non autorisé' });
  try {
    if (req.method === 'POST') {
      const { email, role } = req.body;
      await sb.from('brand_team').insert({ brand_id: user.id, email, role: role||'manager', status:'invited', created_at: new Date().toISOString() });
      return res.status(200).json({ ok:true });
    }
    if (req.method === 'GET') {
      const { data } = await sb.from('brand_team').select('*').eq('brand_id', user.id);
      return res.status(200).json({ team: data||[] });
    }
    return res.status(405).json({ error:'Méthode non autorisée' });
  } catch(err) { return res.status(500).json({ error: err.message }); }
}
