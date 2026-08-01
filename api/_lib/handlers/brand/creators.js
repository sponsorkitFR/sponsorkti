// api/brand/creators.js — Liste des créateurs disponibles (profils publics)
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = req.headers.authorization?.replace('Bearer ','');
  const { error } = await sb.auth.getUser(token);
  if (error) return res.status(401).json({ error:'Non autorisé' });
  try {
    const { niche, platform, max_rate } = req.query;
    let query = sb.from('profiles').select('id,first_name,channel_name,platform,subscribers,engagement_rate,avg_views,niche,base_rate').eq('public_profile', true);
    if (niche) query = query.ilike('niche', `%${niche}%`);
    if (platform) query = query.eq('platform', platform);
    if (max_rate) query = query.lte('base_rate', parseInt(max_rate));
    const { data } = await query.order('subscribers', { ascending: false }).limit(100);
    return res.status(200).json({ creators: data || [] });
  } catch(err) { return res.status(500).json({ error: err.message }); }
}
