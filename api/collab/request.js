// api/collab/request.js
// Demandes de collaboration entre créateurs et/ou marques

import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Non autorisé' });

  try {
    // ── GET : mes demandes reçues + envoyées ──────────────────────────
    if (req.method === 'GET') {
      const { filter = 'received' } = req.query;

      const query = filter === 'received'
        ? sb.from('collab_requests').select('*').eq('receiver_id', user.id)
        : sb.from('collab_requests').select('*').eq('sender_id', user.id);

      const { data: requests } = await query.order('created_at', { ascending: false });

      // Enrichir avec les infos des participants
      const enriched = await Promise.all((requests || []).map(async r => {
        const otherId = filter === 'received' ? r.sender_id : r.receiver_id;

        const { data: profile } = await sb.from('profiles')
          .select('first_name, channel_name, platform, niche, subscribers, engagement_rate').eq('id', otherId).single();
        const { data: brand } = profile ? { data: null } : await sb.from('brands')
          .select('brand_name, sector, monthly_budget').eq('id', otherId).single();

        const other = profile || brand;
        return {
          ...r,
          other_user: {
            id: otherId,
            name: other?.channel_name || other?.first_name || other?.brand_name || 'Utilisateur',
            type: profile ? 'creator' : 'brand',
            subtitle: other?.platform || other?.sector || '',
            subscribers: profile?.subscribers,
            engagement_rate: profile?.engagement_rate
          }
        };
      }));

      return res.status(200).json({ requests: enriched });
    }

    // ── POST : envoyer une demande de collab ──────────────────────────
    if (req.method === 'POST') {
      const { receiver_id, type, title, description, budget } = req.body;

      if (!receiver_id || !title || !type) {
        return res.status(400).json({ error: 'receiver_id, title et type requis' });
      }
      if (receiver_id === user.id) {
        return res.status(400).json({ error: 'Impossible de s\'envoyer une collab à soi-même' });
      }

      // Vérifier si une demande en attente existe déjà
      const { data: existing } = await sb.from('collab_requests')
        .select('id, status')
        .eq('sender_id', user.id)
        .eq('receiver_id', receiver_id)
        .eq('status', 'pending')
        .single();

      if (existing) return res.status(409).json({ error: 'Une demande est déjà en attente', existing_id: existing.id });

      // Déterminer le type de compte de l'expéditeur
      const { data: isCreator } = await sb.from('profiles').select('id').eq('id', user.id).single();
      const sender_type = isCreator ? 'creator' : 'brand';

      const { data, error } = await sb.from('collab_requests').insert({
        sender_id: user.id,
        receiver_id,
        sender_type,
        type,
        title: title.trim(),
        description: description?.trim() || null,
        budget: budget ? parseFloat(budget) : null,
        status: 'pending',
        created_at: new Date().toISOString()
      }).select().single();

      if (error) throw error;
      return res.status(201).json({ request: data });
    }

    // ── PUT : accepter / refuser / compléter ──────────────────────────
    if (req.method === 'PUT') {
      const { id, status, response_message } = req.body;
      if (!id || !status) return res.status(400).json({ error: 'id et status requis' });

      const validTransitions = {
        pending: ['accepted', 'declined'],
        accepted: ['completed', 'cancelled'],
        declined: [],
        completed: [],
        cancelled: []
      };

      const { data: existing } = await sb.from('collab_requests')
        .select('*').eq('id', id)
        .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
        .single();

      if (!existing) return res.status(404).json({ error: 'Demande non trouvée' });

      // Vérifier la permission : seul le destinataire peut accepter/refuser
      if (['accepted', 'declined'].includes(status) && existing.receiver_id !== user.id) {
        return res.status(403).json({ error: 'Seul le destinataire peut accepter ou refuser' });
      }

      if (!validTransitions[existing.status]?.includes(status)) {
        return res.status(400).json({ error: `Transition ${existing.status} → ${status} non autorisée` });
      }

      const { data } = await sb.from('collab_requests').update({
        status,
        updated_at: new Date().toISOString()
      }).eq('id', id).select().single();

      // Si acceptée : créer automatiquement une conversation
      if (status === 'accepted') {
        const p1 = user.id < existing.sender_id ? user.id : existing.sender_id;
        const p2 = user.id < existing.sender_id ? existing.sender_id : user.id;

        const { data: existingConv } = await sb.from('conversations')
          .select('id').eq('participant_1', p1).eq('participant_2', p2).single();

        if (!existingConv) {
          await sb.from('conversations').insert({
            participant_1: p1, participant_2: p2,
            last_message: `Collaboration "${existing.title}" acceptée !`,
            last_message_at: new Date().toISOString(),
            created_at: new Date().toISOString()
          });
        }
        // Message automatique dans la conversation
        const { data: conv } = await sb.from('conversations')
          .select('id').eq('participant_1', p1).eq('participant_2', p2).single();
        if (conv) {
          await sb.from('messages').insert({
            conversation_id: conv.id,
            sender_id: user.id,
            content: `Collaboration "${existing.title}" acceptée ! ${response_message || 'Ravi de collaborer avec toi.'}`,
            read: false,
            created_at: new Date().toISOString()
          });
        }
      }

      return res.status(200).json({ request: data });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    console.error('Collab request error:', err);
    return res.status(500).json({ error: err.message });
  }
}
