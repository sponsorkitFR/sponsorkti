// api/ai/sponsors.js — Moteur de matching de sponsors
//
// GET  : retourne les sponsors déjà matchés pour l'utilisateur (cache)
// POST : relance le matching — filtre la base de sponsors selon le profil réel
//        (niche, abonnés, formats déjà testés), puis demande à Claude de
//        scorer et classer les meilleurs candidats avec une raison + tarif suggéré

import { createClient } from '@supabase/supabase-js';
import { callAI, extractJSON } from '../../ai-client.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('sponsor_matches')
        .select('*, sponsor_database(*)')
        .eq('user_id', userId)
        .order('match_score', { ascending: false })
        .limit(20);
      if (error) throw error;
      return res.status(200).json({ matches: data });
    }

    if (req.method === 'POST') {
      // 1. Charger profil + deals + mémoire
      const [{ data: profile }, { data: deals }, { data: memories }] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', userId).single(),
        supabase.from('deals').select('*').eq('user_id', userId),
        supabase.from('ai_memory').select('category,content').eq('user_id', userId)
      ]);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });

      const subs = profile.subscribers || 0;
      const niche = (profile.niche || 'tech').toLowerCase();
      const alreadyWorkedWith = (deals || []).map(d => (d.brand || '').toLowerCase());

      // 2. Pré-filtrer la base de sponsors par compatibilité dure
      // (audience min/max + niche dans le tableau de niches du sponsor)
      const { data: candidates, error: candErr } = await supabase
        .from('sponsor_database')
        .select('*')
        .eq('active', true)
        .lte('min_subs', Math.max(subs, 1))
        .or(`max_subs.is.null,max_subs.gte.${subs}`);
      if (candErr) throw candErr;

      const filtered = (candidates || []).filter(c => {
        const alreadyDone = alreadyWorkedWith.includes((c.brand_name || '').toLowerCase());
        const nicheMatch = (c.niches || []).some(n => n.toLowerCase() === niche || niche.includes(n.toLowerCase()) || n.toLowerCase().includes(niche));
        return !alreadyDone && nicheMatch;
      });

      // Si le filtre strict ne retourne rien (niche inconnue), élargir à tout le catalogue éligible
      const pool = filtered.length > 0 ? filtered : (candidates || []).filter(c => !alreadyWorkedWith.includes((c.brand_name || '').toLowerCase()));

      if (pool.length === 0) {
        return res.status(200).json({ matches: [], message: 'Aucun sponsor disponible pour ce profil actuellement.' });
      }

      // 3. Demander à Claude de scorer/classer les meilleurs candidats
      const totalRevenue = (deals || []).reduce((s, d) => s + (d.amount || 0), 0);
      const avgDeal = deals && deals.length > 0 ? Math.round(totalRevenue / deals.length) : 0;
      const memoryBlock = (memories || []).length > 0
        ? `\nPréférences connues du créateur :\n${memories.map(m => `- [${m.category}] ${m.content}`).join('\n')}`
        : '';

      const prompt = `Tu es un expert en sponsoring créateur. Voici le profil du créateur :
- Niche : ${profile.niche || '?'}
- Plateforme : ${profile.platform || 'YouTube'}
- Abonnés : ${subs.toLocaleString()}
- Engagement : ${profile.engagement_rate || '?'}%
- Vues moyennes : ${(profile.avg_views || 0).toLocaleString()}
- Deal moyen actuel : ${avgDeal.toLocaleString()}€
- Marques déjà travaillées : ${alreadyWorkedWith.join(', ') || 'aucune'}${memoryBlock}

Voici une liste de sponsors potentiels (JSON) :
${JSON.stringify(pool.map(p => ({ id: p.id, brand_name: p.brand_name, sector: p.sector, niches: p.niches, budget_min: p.budget_min, budget_max: p.budget_max, formats: p.formats, notes: p.notes })), null, 0)}

Sélectionne les 8 MEILLEURS matchs pour ce créateur précis. Pour chacun, donne :
- "id" : l'id exact fourni
- "score" : 0-100 (pertinence du match)
- "reasoning" : 1 phrase expliquant pourquoi ce sponsor est pertinent POUR CE CRÉATEUR (utilise ses vraies stats)
- "suggested_rate" : tarif suggéré en euros (nombre entier), cohérent avec budget du sponsor ET stats du créateur

Réponds UNIQUEMENT avec un tableau JSON valide, trié par score décroissant, rien d'autre.`;

      let ranked;
      try {
        const { text } = await callAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 2000, json: true });
        ranked = extractJSON(text);
        if (!Array.isArray(ranked)) throw new Error('AI did not return an array');
      } catch (e) {
        console.error('AI matching error:', e);
        return res.status(502).json({ error: e.message || 'AI ranking error' });
      }

      // 4. Sauvegarder les matches (remplace les anciens "new" pour rester frais)
      await supabase.from('sponsor_matches').delete().eq('user_id', userId).eq('status', 'new');
      const rows = ranked
        .filter(r => pool.some(p => p.id === r.id))
        .map(r => ({
          user_id: userId,
          sponsor_id: r.id,
          match_score: Math.max(0, Math.min(100, Math.round(r.score || 0))),
          reasoning: r.reasoning || '',
          suggested_rate: Math.round(r.suggested_rate || 0),
          status: 'new'
        }));

      if (rows.length > 0) {
        const { error: insErr } = await supabase.from('sponsor_matches').insert(rows);
        if (insErr) throw insErr;
      }

      const { data: full, error: fullErr } = await supabase
        .from('sponsor_matches')
        .select('*, sponsor_database(*)')
        .eq('user_id', userId)
        .order('match_score', { ascending: false })
        .limit(20);
      if (fullErr) throw fullErr;

      return res.status(200).json({ matches: full });
    }

    // PATCH-like via POST body action (status update: contacted/dismissed/converted)
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Sponsor matching error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function getUserId(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}
