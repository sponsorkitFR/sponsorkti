// api/brand/deliverables.js — Validation des livrables
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = req.headers.authorization?.replace('Bearer ','');
  const { data:{ user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error:'Non autorisé' });
  try {
    if (req.method === 'GET') {
      const { data } = await sb.from('deliverables')
        .select('*, campaigns(title,brand_id), profiles(first_name,channel_name)')
        .eq('campaigns.brand_id', user.id)
        .order('created_at', { ascending: false });
      return res.status(200).json({ deliverables: (data||[]).map(d => ({
        ...d, campaign_title: d.campaigns?.title,
        creator_name: d.profiles?.channel_name || d.profiles?.first_name
      })) });
    }
    if (req.method === 'PUT') {
      const { id, status, revision_notes } = req.body;
      const { data } = await sb.from('deliverables').update({ status, revision_notes, updated_at: new Date().toISOString() }).eq('id', id).select().single();
      await sb.from('notifications').insert({
        user_id: data.creator_id, type: 'deliverable_reviewed',
        title: status === 'approved' ? '✅ Livrable approuvé !' : status === 'rejected' ? '❌ Livrable rejeté' : '✏️ Modifications demandées',
        message: revision_notes || (status === 'approved' ? 'Votre contenu a été approuvé.' : 'Vérifiez les retours de la marque.'),
        read: false, created_at: new Date().toISOString()
      });
      return res.status(200).json({ deliverable: data });
    }
    return res.status(405).json({ error:'Méthode non autorisée' });
  } catch(err) { return res.status(500).json({ error: err.message }); }
}
