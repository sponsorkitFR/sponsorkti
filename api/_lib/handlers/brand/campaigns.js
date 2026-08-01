// api/brand/campaigns.js — CRUD campagnes marque

import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ','');
  const { data:{ user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error:'Non autorisé' });

  try {
    if (req.method === 'GET') {
      const { data } = await sb
        .from('campaigns')
        .select(`*, campaign_creators(count), applications(count), deliverables(count)`)
        .eq('brand_id', user.id)
        .order('created_at', { ascending: false });

      // Enrichir avec les counts
      const campaigns = (data||[]).map(c => ({
        ...c,
        creators_count: c.campaign_creators?.[0]?.count || 0,
        applications_count: c.applications?.[0]?.count || 0,
        deliverables_pending: c.deliverables?.filter?.(d=>d.status==='pending_review').length || 0
      }));
      return res.status(200).json({ campaigns });
    }

    if (req.method === 'POST') {
      const { title, status='draft', total_budget, creators_needed, format, start_date, end_date, description, target_niches, brief } = req.body;
      if (!title) return res.status(400).json({ error:'Titre requis' });
      const { data, error:err } = await sb.from('campaigns').insert({
        brand_id: user.id, title, status, total_budget: total_budget||0,
        creators_needed: creators_needed||0, format, start_date: start_date||null,
        end_date: end_date||null, description, target_niches: target_niches||[],
        brief: brief||null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).select().single();
      if (err) throw err;
      return res.status(201).json({ campaign: data });
    }

    if (req.method === 'PUT') {
      const { id, ...updates } = req.body;
      const { data:existing } = await sb.from('campaigns').select('brand_id').eq('id',id).single();
      if (!existing || existing.brand_id !== user.id) return res.status(403).json({ error:'Accès refusé' });
      updates.updated_at = new Date().toISOString();
      const { data, error:err } = await sb.from('campaigns').update(updates).eq('id',id).select().single();
      if (err) throw err;
      return res.status(200).json({ campaign: data });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      const { data:existing } = await sb.from('campaigns').select('brand_id').eq('id',id).single();
      if (!existing || existing.brand_id !== user.id) return res.status(403).json({ error:'Accès refusé' });
      await sb.from('campaigns').delete().eq('id',id);
      return res.status(200).json({ ok:true });
    }

    return res.status(405).json({ error:'Méthode non autorisée' });
  } catch(err) {
    console.error('Campaigns error:', err);
    return res.status(500).json({ error: err.message });
  }
}
