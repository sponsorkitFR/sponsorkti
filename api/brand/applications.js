// api/brand/applications.js — Candidatures créateurs aux campagnes
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
      const { data } = await sb.from('applications')
        .select('*, campaigns(title,brand_id), profiles(first_name,channel_name)')
        .eq('campaigns.brand_id', user.id)
        .order('created_at', { ascending: false });
      const apps = (data||[]).map(a => ({
        ...a, campaign_title: a.campaigns?.title,
        creator_name: a.profiles?.channel_name || a.profiles?.first_name
      }));
      return res.status(200).json({ applications: apps });
    }
    if (req.method === 'POST') {
      const { creator_id, campaign_id, message, type } = req.body;
      const { data } = await sb.from('applications').insert({
        creator_id, campaign_id, message, type: type||'creator_apply',
        status: 'pending', created_at: new Date().toISOString()
      }).select().single();
      return res.status(201).json({ application: data });
    }
    if (req.method === 'PUT') {
      const { id, status } = req.body;
      const { data } = await sb.from('applications').update({ status, updated_at: new Date().toISOString() }).eq('id', id).select().single();
      if (status === 'accepted') {
        await sb.from('notifications').insert({
          user_id: data.creator_id, type: 'application_accepted',
          title: 'Candidature acceptée !', message: 'Une marque a accepté votre candidature.',
          read: false, created_at: new Date().toISOString()
        });
      }
      return res.status(200).json({ application: data });
    }
    return res.status(405).json({ error:'Méthode non autorisée' });
  } catch(err) { return res.status(500).json({ error: err.message }); }
}
