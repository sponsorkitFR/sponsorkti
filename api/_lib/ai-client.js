// api/_lib/ai-client.js — Couche d'abstraction IA
//
// Toutes les routes IA de SponsorKit passent par callAI() au lieu d'appeler
// directement un fournisseur. Ça permet de changer de moteur IA en une seule
// variable d'environnement, sans toucher au code métier.
//
// AI_PROVIDER = 'gemini'    (par défaut) → Google Gemini, GRATUIT (clé GEMINI_API_KEY)
// AI_PROVIDER = 'anthropic'              → Claude (clé ANTHROPIC_API_KEY)
//
// Pour remettre Anthropic plus tard : ajoute ANTHROPIC_API_KEY dans Vercel et
// change AI_PROVIDER=anthropic. Aucune autre modification de code nécessaire.

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

/**
 * Appelle le modèle IA configuré.
 *
 * @param {Object} opts
 * @param {string} [opts.system] - prompt système (instructions, contexte)
 * @param {Array<{role:'user'|'assistant', content:string}>} opts.messages - historique de conversation
 * @param {number} [opts.maxTokens] - nombre max de tokens en sortie
 * @param {boolean} [opts.json] - si true, demande une réponse JSON stricte (utile pour le matching/extraction)
 * @returns {Promise<{text: string, provider: string}>}
 */
export async function callAI({ system = '', messages = [], maxTokens = 1000, json = false }) {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();

  if (provider === 'anthropic') {
    return callAnthropic({ system, messages, maxTokens, json });
  }
  return callGemini({ system, messages, maxTokens, json });
}

// ── GEMINI (gratuit) ──────────────────────────────────────────────────
async function callGemini({ system, messages, maxTokens, json }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY manquante. Ajoute-la dans les variables d\'environnement Vercel (gratuit sur aistudio.google.com).');

  // Gemini utilise les rôles 'user' et 'model' (pas 'assistant')
  const contents = messages
    .filter(m => m.content && m.content.trim())
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  // Gemini exige que 'contents' ne soit pas vide et commence par 'user'
  if (contents.length === 0 || contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: '(début de conversation)' }] });
  }

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: 'application/json' } : {})
    }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await fetch(`${GEMINI_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.message || 'Erreur Gemini inconnue';
    // Erreur explicite si quota dépassé (429) — utile pour debug
    if (res.status === 429) throw new Error(`Quota Gemini dépassé (429). Réessaie dans quelques minutes. (${msg})`);
    throw new Error(`Gemini error (${res.status}): ${msg}`);
  }

  const candidate = data?.candidates?.[0];
  // Gemini peut bloquer une réponse pour des raisons de sécurité ("finishReason": "SAFETY")
  if (!candidate || candidate.finishReason === 'SAFETY') {
    return { text: '', provider: 'gemini' };
  }

  const text = (candidate.content?.parts || []).map(p => p.text || '').join('');
  return { text, provider: 'gemini' };
}

// ── ANTHROPIC (payant, à réactiver plus tard) ──────────────────────────
async function callAnthropic({ system, messages, maxTokens, json }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante.');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: system || '',
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic error (${res.status})`);

  const text = data.content?.[0]?.text || '';
  return { text, provider: 'anthropic' };
}

// Petit utilitaire : extrait un JSON même si le modèle a ajouté du texte
// autour (```json ... ``` ou des phrases avant/après)
export function extractJSON(text) {
  const cleaned = (text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) { try { return JSON.parse(match[0]); } catch (e) {} }
  return null;
}
