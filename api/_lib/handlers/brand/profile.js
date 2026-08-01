// api/brand/profile.js
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = req.headers.authorization?.replace('Bearer ','');
  const { data:{ user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error:'Non autorisé' });
  try {
    if (req.method === 'GET') {
      const { data } = await sb.from('brands').select('*').eq('id', user.id).single();
      return res.status(200).json({ brand: data });
    }
    if (req.method === 'PUT') {
      const allowed = ['brand_name','website','sector','description','team_size','monthly_budget'];
      const updates = {};
      allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
      updates.updated_at = new Date().toISOString();
      const { data } = await sb.from('brands').update(updates).eq('id', user.id).select().single();
      return res.status(200).json({ brand: data });
    }
    return res.status(405).json({ error:'Méthode non autorisée' });
  } catch(err) { return res.status(500).json({ error: err.message }); }
}
