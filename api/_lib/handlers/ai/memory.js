// api/ai/memory.js — Mémoire long-terme de l'IA
// GET  : récupère tous les faits mémorisés sur l'utilisateur
// POST : ajoute / met à jour un fait (depuis le chat ou une automatisation)
// DELETE : supprime un fait (l'utilisateur peut "faire oublier" l'IA)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('ai_memory')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return res.status(200).json({ memories: data });
    }

    if (req.method === 'POST') {
      const { category, content, source } = req.body;
      if (!category || !content) return res.status(400).json({ error: 'category and content required' });

      // Évite les doublons proches : si un fait similaire existe dans la même
      // catégorie, on le met à jour plutôt que d'en créer un nouveau.
      const { data: existing } = await supabase
        .from('ai_memory')
        .select('id, content')
        .eq('user_id', userId)
        .eq('category', category);

      const duplicate = (existing || []).find(m =>
        similarity(m.content.toLowerCase(), content.toLowerCase()) > 0.6
      );

      if (duplicate) {
        const { data, error } = await supabase
          .from('ai_memory')
          .update({ content, updated_at: new Date().toISOString(), source: source || 'chat' })
          .eq('id', duplicate.id)
          .select()
          .single();
        if (error) throw error;
        return res.status(200).json({ memory: data, action: 'updated' });
      }

      const { data, error } = await supabase
        .from('ai_memory')
        .insert({ user_id: userId, category, content, source: source || 'chat' })
        .select()
        .single();
      if (error) throw error;
      return res.status(201).json({ memory: data, action: 'created' });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      const { error } = await supabase.from('ai_memory').delete().eq('id', id).eq('user_id', userId);
      if (error) throw error;
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Memory API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Similarité simple basée sur les mots partagés (suffisant pour dédupliquer)
function similarity(a, b) {
  const wa = new Set(a.split(/\s+/).filter(w => w.length > 3));
  const wb = new Set(b.split(/\s+/).filter(w => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size);
}

async function getUserId(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}
