// api/deals.js — CRUD complet des deals par utilisateur
// Chaque créateur voit et gère uniquement SES deals

import { createClient } from '@supabase/supabase-js';

// Client avec service role pour bypasser RLS côté serveur
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // clé service role, jamais côté client
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── AUTH : vérifier le token Supabase ─────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token requis' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token invalide' });

  const userId = user.id;

  try {
    // ── GET : récupérer tous les deals de l'utilisateur ──────────────────
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('deals')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return res.status(200).json({ deals: data });
    }

    // ── POST : créer un nouveau deal ──────────────────────────────────────
    if (req.method === 'POST') {
      const { brand, contact_email, format, amount, status, notes, deadline } = req.body;

      if (!brand) return res.status(400).json({ error: 'Nom de marque requis' });

      const deal = {
        user_id: userId,
        brand: brand.trim(),
        contact_email: contact_email?.trim() || null,
        format: format || 'integration',
        amount: parseFloat(amount) || 0,
        status: status || 'prospect',
        notes: notes?.trim() || null,
        deadline: deadline || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase.from('deals').insert(deal).select().single();
      if (error) throw error;
      return res.status(201).json({ deal: data });
    }

    // ── PUT : modifier un deal ─────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { id, ...updates } = req.body;
      if (!id) return res.status(400).json({ error: 'ID requis' });

      // Vérifier que le deal appartient bien à cet user
      const { data: existing } = await supabase
        .from('deals').select('user_id').eq('id', id).single();
      if (!existing || existing.user_id !== userId)
        return res.status(403).json({ error: 'Accès refusé' });

      const { data, error } = await supabase
        .from('deals')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select().single();

      if (error) throw error;
      return res.status(200).json({ deal: data });
    }

    // ── DELETE : supprimer un deal ────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'ID requis' });

      const { data: existing } = await supabase
        .from('deals').select('user_id').eq('id', id).single();
      if (!existing || existing.user_id !== userId)
        return res.status(403).json({ error: 'Accès refusé' });

      await supabase.from('deals').delete().eq('id', id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });

  } catch (err) {
    console.error('Deals error:', err);
    return res.status(500).json({ error: err.message });
  }
}
