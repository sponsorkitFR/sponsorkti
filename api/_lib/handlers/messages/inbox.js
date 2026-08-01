// api/messages/inbox.js
// Messagerie directe — inbox + conversations + envoi

import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Non autorisé' });

  try {
    // ── GET inbox : toutes mes conversations ─────────────────────────
    if (req.method === 'GET' && !req.query.conversation_id) {
      const { data: convs } = await sb.from('conversations')
        .select('*')
        .or(`participant_1.eq.${user.id},participant_2.eq.${user.id}`)
        .order('last_message_at', { ascending: false })
        .limit(50);

      if (!convs) return res.status(200).json({ conversations: [] });

      // Enrichir avec les infos de l'autre participant
      const enriched = await Promise.all(convs.map(async conv => {
        const otherId = conv.participant_1 === user.id ? conv.participant_2 : conv.participant_1;

        // Chercher créateur ou marque
        const { data: otherProfile } = await sb.from('profiles')
          .select('id, first_name, channel_name, platform, niche').eq('id', otherId).single();
        const { data: otherBrand } = otherProfile ? { data: null } : await sb.from('brands')
          .select('id, brand_name, sector').eq('id', otherId).single();

        const other = otherProfile || otherBrand;
        const myUnread = conv.participant_1 === user.id ? conv.unread_1 : conv.unread_2;

        return {
          ...conv,
          other_user: other ? {
            id: otherId,
            name: other.channel_name || other.first_name || other.brand_name || 'Utilisateur',
            type: otherProfile ? 'creator' : 'brand',
            subtitle: other.platform || other.sector || ''
          } : null,
          my_unread: myUnread
        };
      }));

      return res.status(200).json({ conversations: enriched.filter(c => c.other_user) });
    }

    // ── GET messages d'une conversation ──────────────────────────────
    if (req.method === 'GET' && req.query.conversation_id) {
      const { conversation_id, cursor } = req.query;

      // Vérifier accès
      const { data: conv } = await sb.from('conversations').select('*')
        .eq('id', conversation_id)
        .or(`participant_1.eq.${user.id},participant_2.eq.${user.id}`)
        .single();
      if (!conv) return res.status(403).json({ error: 'Accès refusé' });

      let query = sb.from('messages')
        .select('*')
        .eq('conversation_id', conversation_id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (cursor) query = query.lt('created_at', cursor);
      const { data: msgs } = await query;

      // Marquer comme lus
      await sb.from('messages').update({ read: true })
        .eq('conversation_id', conversation_id)
        .neq('sender_id', user.id)
        .eq('read', false);

      // Reset unread count
      const field = conv.participant_1 === user.id ? 'unread_1' : 'unread_2';
      await sb.from('conversations').update({ [field]: 0 }).eq('id', conversation_id);

      return res.status(200).json({ messages: (msgs || []).reverse(), conversation: conv });
    }

    // ── POST : envoyer un message ─────────────────────────────────────
    if (req.method === 'POST') {
      const { receiver_id, content, conversation_id: existingConvId } = req.body;
      if (!content?.trim()) return res.status(400).json({ error: 'Message vide' });
      if (content.length > 2000) return res.status(400).json({ error: 'Message trop long (max 2000 car.)' });

      let convId = existingConvId;

      if (!convId) {
        if (!receiver_id) return res.status(400).json({ error: 'receiver_id ou conversation_id requis' });
        // Créer ou récupérer la conversation
        // Toujours stocker participant_1 < participant_2 (pour l'unicité)
        const p1 = user.id < receiver_id ? user.id : receiver_id;
        const p2 = user.id < receiver_id ? receiver_id : user.id;

        const { data: existingConv } = await sb.from('conversations')
          .select('id').eq('participant_1', p1).eq('participant_2', p2).single();

        if (existingConv) {
          convId = existingConv.id;
        } else {
          const { data: newConv } = await sb.from('conversations').insert({
            participant_1: p1, participant_2: p2,
            created_at: new Date().toISOString()
          }).select().single();
          convId = newConv.id;
        }
      }

      // Insérer le message
      const { data: msg } = await sb.from('messages').insert({
        conversation_id: convId,
        sender_id: user.id,
        content: content.trim(),
        read: false,
        created_at: new Date().toISOString()
      }).select().single();

      // Mettre à jour last_message + unread
      const { data: conv } = await sb.from('conversations').select('*').eq('id', convId).single();
      const otherIsP1 = conv.participant_1 !== user.id;
      await sb.from('conversations').update({
        last_message: content.slice(0, 100),
        last_message_at: new Date().toISOString(),
        [otherIsP1 ? 'unread_1' : 'unread_2']: (otherIsP1 ? conv.unread_1 : conv.unread_2) + 1
      }).eq('id', convId);

      // Notification push
      const otherId = conv.participant_1 === user.id ? conv.participant_2 : conv.participant_1;
      const { data: myProfile } = await sb.from('profiles').select('channel_name, first_name').eq('id', user.id).single();
      const { data: myBrand } = await sb.from('brands').select('brand_name').eq('id', user.id).single();
      const myName = myProfile?.channel_name || myProfile?.first_name || myBrand?.brand_name || 'Quelqu\'un';

      await sb.from('notifications').insert({
        user_id: otherId, type: 'new_message',
        title: `Message de ${myName}`,
        message: content.slice(0, 80) + (content.length > 80 ? '...' : ''),
        read: false, created_at: new Date().toISOString()
      });

      return res.status(201).json({ message: msg, conversation_id: convId });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    console.error('Messages error:', err);
    return res.status(500).json({ error: err.message });
  }
}
