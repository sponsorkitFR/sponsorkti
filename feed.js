// api/brand/brief-ai.js — Génération IA de briefs, messages outreach et recommandations
import { createClient } from '@supabase/supabase-js';
import { callAI, extractJSON } from '../_lib/ai-client.js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = req.headers.authorization?.replace('Bearer ','');
  const { error } = await sb.auth.getUser(token);
  if (error) return res.status(401).json({ error:'Non autorisé' });

  const { type, campaign, brand, creator } = req.body;
  let prompt = '';

  if (type === 'outreach') {
    prompt = `Tu es un expert en marketing d'influence. Rédige un message de prospection professionnel et personnalisé d'une marque vers un créateur.

Marque : ${brand?.brand_name || 'la marque'} (${brand?.sector || 'secteur inconnu'})
Créateur : ${creator?.channel_name || creator?.first_name} — ${creator?.subscribers?.toLocaleString() || '?'} abonnés, ${creator?.engagement_rate}% engagement, niche ${creator?.niche}
Campagne : ${campaign?.title} — Budget : ${campaign?.total_budget}€ — Format : ${campaign?.format}

Écris un message court (150-200 mots), personnel, qui valorise le créateur et explique pourquoi ce partenariat a du sens. Termine par un appel à l'action clair. Réponds UNIQUEMENT avec le message, sans introduction ni explication.`;
  } else if (type === 'brief') {
    prompt = `Tu es un expert en marketing d'influence. Génère un brief professionnel pour une campagne.

Marque : ${brand?.brand_name} — ${brand?.sector}
Campagne : ${campaign?.title}
Format : ${campaign?.format}
Niches cibles : ${(campaign?.target_niches||[]).join(', ')}
Description : ${campaign?.description || 'Non précisée'}

Réponds UNIQUEMENT en JSON valide :
{
  "objectives": "Objectifs marketing clairs et mesurables",
  "messages": "Messages clés à transmettre aux audiences",
  "constraints": "Mentions obligatoires, hashtags, liens, codes promo"
}`;
  } else if (type === 'dashboard_reco') {
    prompt = `Tu es un conseiller en marketing d'influence. En 2 phrases max, donne une recommandation actionnable à cette marque.

Marque : ${brand?.brand_name || 'la marque'} (${brand?.sector})
Campagnes actives : ${(brand?.campaigns||[]).filter(c=>c.status==='active').length || 0}
Budget mensuel : ${brand?.monthly_budget || 0}€

Sois direct et concret. Réponds UNIQUEMENT avec la recommandation, sans préambule.`;
  }

  try {
    const { text } = await callAI({ messages:[{ role:'user', content: prompt }], maxTokens: 600, json: type === 'brief' });

    if (type === 'brief') {
      const parsed = extractJSON(text);
      if (parsed) return res.status(200).json({ brief: parsed });
      return res.status(200).json({ brief: { objectives: text, messages:'', constraints:'' } });
    }
    if (type === 'outreach') return res.status(200).json({ message: text });
    if (type === 'dashboard_reco') return res.status(200).json({ recommendation: text });

    return res.status(200).json({ text });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
