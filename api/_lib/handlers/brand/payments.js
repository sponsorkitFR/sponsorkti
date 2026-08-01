// api/brand/payments.js — Paiements marque vers créateurs
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = req.headers.authorization?.replace('Bearer ','');
  const { data:{ user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error:'Non autorisé' });
  try {
    if (req.method === 'GET') {
      const { data } = await sb.from('brand_payments')
        .select('*, campaigns(title), profiles(first_name,channel_name)')
        .eq('brand_id', user.id).order('created_at', { ascending: false });
      const payments = (data||[]).map(p => ({
        ...p, campaign_title: p.campaigns?.title,
        creator_name: p.profiles?.channel_name || p.profiles?.first_name
      }));
      const summary = {
        total_paid: payments.filter(p=>p.status==='completed').reduce((s,p)=>s+p.amount,0),
        total_pending: payments.filter(p=>p.status==='pending').reduce((s,p)=>s+p.amount,0),
        creators_paid: new Set(payments.filter(p=>p.status==='completed').map(p=>p.creator_id)).size
      };
      return res.status(200).json({ payments, summary });
    }
    if (req.method === 'POST') {
      const { campaign_id, creator_id, amount, method } = req.body;
      const { data } = await sb.from('brand_payments').insert({
        brand_id: user.id, campaign_id, creator_id, amount, method,
        status: 'pending', created_at: new Date().toISOString()
      }).select().single();
      await sb.from('notifications').insert({
        user_id: creator_id, type: 'payment_incoming',
        title: '💰 Paiement en cours',
        message: `Un paiement de ${amount}€ a été initié par la marque.`,
        read: false, created_at: new Date().toISOString()
      });
      return res.status(201).json({ payment: data });
    }
    return res.status(405).json({ error:'Méthode non autorisée' });
  } catch(err) { return res.status(500).json({ error: err.message }); }
}
