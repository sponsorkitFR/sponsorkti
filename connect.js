// api/ai/agent-chat.js — Chat IA multi-agents avec mémoire persistante
//
// Architecture :
// 1. Un agent "routeur" classe le message dans une catégorie (prospection,
//    négociation, analyse, relance, général)
// 2. Le message est traité par un agent spécialisé avec un system prompt dédié
// 3. La mémoire long-terme (faits appris) est injectée dans le contexte
// 4. Après la réponse, un agent "mémoire" extrait silencieusement les faits
//    importants à retenir pour les prochaines conversations
// 5. Tout est sauvegardé dans ai_conversations pour persister entre sessions

import { createClient } from '@supabase/supabase-js';
import { callAI, extractJSON } from '../_lib/ai-client.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const AGENTS = {
  prospector: {
    label: 'Prospection',
    system: `Tu es l'agent PROSPECTION de SponsorKit. Ton rôle : aider le créateur à trouver de nouvelles marques pertinentes, rédiger des pitchs percutants, et identifier les opportunités de sponsoring adaptées à son profil.
- Sois concret : propose des marques réelles compatibles avec sa niche et sa taille d'audience.
- Pour chaque suggestion, donne le format idéal, une fourchette de tarif réaliste et un angle d'approche.
- Si on te demande un email de prospection, structure-le : objet, corps (150-200 mots), call-to-action clair.`
  },
  negotiator: {
    label: 'Négociation',
    system: `Tu es l'agent NÉGOCIATION de SponsorKit. Ton rôle : aider le créateur à obtenir le meilleur deal possible — tarifs, conditions, exclusivité, droits d'usage, délais de paiement.
- Donne toujours des chiffres concrets et des scripts de réponse prêts à envoyer.
- Anticipe les objections probables de la marque et prépare des contre-arguments.
- Rappelle les leviers non-monétaires (durée de visibilité, exclusivité, options de renouvellement) quand le budget est limité.`
  },
  analyst: {
    label: 'Analyse',
    system: `Tu es l'agent ANALYSE de SponsorKit. Ton rôle : analyser les performances du créateur — revenus, taux de conversion des deals, comparaison au marché, tendances dans le temps.
- Base-toi uniquement sur les données réelles fournies dans le contexte.
- Donne des chiffres précis, des pourcentages, des comparaisons avant/après quand c'est possible.
- Termine toujours par 1-2 actions concrètes à prioriser.`
  },
  followup: {
    label: 'Relances',
    system: `Tu es l'agent RELANCES de SponsorKit. Ton rôle : aider le créateur à relancer les marques qui n'ont pas répondu, gérer les deals en attente, et optimiser le timing des suivis.
- Adapte le ton selon le délai écoulé (poli si < 7j, plus direct si > 14j, dernier rappel si > 21j).
- Propose toujours un message prêt à copier-coller.
- Si plusieurs deals sont concernés, priorise par valeur et par ancienneté.`
  },
  general: {
    label: 'Général',
    system: `Tu es l'assistant général de SponsorKit, expert en sponsoring pour créateurs de contenu. Tu couvres toutes les questions : stratégie de monétisation, pricing, organisation, juridique de base (contrats, droits), productivité, croissance d'audience.
- Réponds à TOUTES les questions du créateur, même si elles ne concernent pas directement les deals — médiakit, branding personnel, gestion du temps, fiscalité des revenus créateurs, etc.
- Si la question dépasse ton expertise (ex: conseil juridique précis, fiscalité complexe), donne une réponse générale utile et recommande de consulter un professionnel.
- Sois concis : 2-5 phrases sauf si une liste structurée est clairement utile.`
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const userId = await getUserId(req);
    const { message, lang, baseContext, forcedAgent } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const langInstruction = {
      fr: 'Réponds toujours en français.', en: 'Always respond in English.',
      es: 'Responde siempre en español.', de: 'Antworte immer auf Deutsch.'
    }[lang] || 'Réponds toujours en français.';

    // ── 1. Charger l'historique persistant + la mémoire long-terme ─────
    let history = [];
    let memories = [];
    if (userId) {
      const [{ data: hist }, { data: mem }] = await Promise.all([
        supabase.from('ai_conversations').select('role,content,agent').eq('user_id', userId).order('created_at', { ascending: true }).limit(40),
        supabase.from('ai_memory').select('category,content').eq('user_id', userId).order('updated_at', { ascending: false }).limit(25)
      ]);
      history = hist || [];
      memories = mem || [];
    }

    // ── 2. Router : choisir l'agent ─────────────────────────────────────
    const agentKey = forcedAgent && AGENTS[forcedAgent] ? forcedAgent : await routeToAgent(message, history);
    const agent = AGENTS[agentKey];

    // ── 3. Construire le contexte enrichi ───────────────────────────────
    const memoryBlock = memories.length > 0
      ? `\n\n# Ce que tu sais déjà sur ce créateur (mémoire long-terme, à utiliser sans le redemander) :\n${memories.map(m => `- [${m.category}] ${m.content}`).join('\n')}`
      : '';

    const systemPrompt = `${agent.system}\n\n${langInstruction}\n\n${baseContext || ''}${memoryBlock}\n\nTu fais partie d'une équipe de plusieurs agents IA spécialisés (prospection, négociation, analyse, relances, général). Le message a été routé vers toi car il correspond à ton domaine. Si une autre question hors de ton domaine apparaît dans la même conversation, traite-la quand même de façon utile.`;

    // ── 4. Construire les messages (historique + nouveau message) ──────
    const msgs = [
      ...history.slice(-20).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    // ── 5. Appel au modèle IA configuré (Gemini gratuit par défaut) ──────
    let reply;
    try {
      const result = await callAI({ system: systemPrompt, messages: msgs, maxTokens: 1500 });
      reply = result.text;
    } catch (e) {
      console.error('AI call error:', e);
      return res.status(502).json({ error: e.message || 'AI provider error' });
    }

    // ── 6. Persister la conversation ────────────────────────────────────
    if (userId) {
      await supabase.from('ai_conversations').insert([
        { user_id: userId, agent: agentKey, role: 'user', content: message },
        { user_id: userId, agent: agentKey, role: 'assistant', content: reply }
      ]);

      // ── 7. Agent mémoire : extraction silencieuse de faits à retenir ──
      extractMemory(userId, message, reply, langInstruction).catch(e => console.error('Memory extraction failed:', e));
    }

    return res.status(200).json({
      reply,
      agent: agentKey,
      agentLabel: agent.label
    });
  } catch (err) {
    console.error('Agent chat error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Classifie le message dans l'un des agents disponibles via un appel rapide
// et peu coûteux (haiku-like : on utilise le même modèle avec max_tokens très bas)
async function routeToAgent(message, history) {
  const recentContext = history.slice(-4).map(h => `${h.role}: ${h.content.slice(0, 150)}`).join('\n');
  const prompt = `Message du créateur : "${message}"

Contexte récent :
${recentContext || '(aucun)'}

Classe ce message dans UNE seule catégorie parmi : prospector, negotiator, analyst, followup, general.
- prospector : trouver des marques, rédiger un pitch/email de prospection
- negotiator : négocier un tarif, des conditions, répondre à une marque qui propose un montant
- analyst : analyser des performances, des revenus, des stats, comparer au marché
- followup : relancer une marque qui n'a pas répondu, gérer un deal en attente
- general : toute autre question (stratégie générale, productivité, juridique, etc.)

Réponds UNIQUEMENT avec le mot-clé de la catégorie, rien d'autre.`;

  try {
    const { text } = await callAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 10 });
    const key = text?.trim().toLowerCase().replace(/[^a-z]/g, '');
    return AGENTS[key] ? key : 'general';
  } catch (e) {
    return 'general';
  }
}

// Extrait des faits durables de l'échange (préférences, objectifs, deals mentionnés,
// styles de communication, marques à éviter...) et les enregistre dans ai_memory
async function extractMemory(userId, userMsg, aiReply, langInstruction) {
  const prompt = `Conversation :
Créateur : ${userMsg}
Assistant : ${aiReply}

${langInstruction}

Si cette conversation révèle un fait DURABLE et utile à retenir pour les prochaines fois (préférence de négociation, objectif financier, marque à éviter, style de communication préféré, info sur l'audience non mentionnée avant, etc.), réponds avec un JSON de la forme :
{"category": "preference|goal|fact|warning|style", "content": "phrase courte et factuelle au présent"}

Si rien de durable ne mérite d'être retenu, réponds exactement : {"category": null}

Réponds UNIQUEMENT avec le JSON, rien d'autre.`;

  let parsed;
  try {
    const { text } = await callAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 200, json: true });
    parsed = extractJSON(text);
  } catch (e) {
    console.error('Memory extraction AI call failed:', e);
    return;
  }
  if (!parsed || !parsed.category || !parsed.content) return;

  // Déduplication simple avant insertion
  const { data: existing } = await supabase
    .from('ai_memory').select('id,content').eq('user_id', userId).eq('category', parsed.category);
  const dup = (existing || []).find(m => {
    const wa = new Set(m.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wb = new Set(parsed.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    let shared = 0; for (const w of wa) if (wb.has(w)) shared++;
    return wa.size && wb.size && shared / Math.max(wa.size, wb.size) > 0.6;
  });
  if (dup) {
    await supabase.from('ai_memory').update({ content: parsed.content, updated_at: new Date().toISOString(), source: 'auto' }).eq('id', dup.id);
  } else {
    await supabase.from('ai_memory').insert({ user_id: userId, category: parsed.category, content: parsed.content, source: 'auto' });
  }
}

async function getUserId(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}
