// api/chat.js — Proxy IA sécurisé (fallback simple, sans mémoire/multi-agents)
// La clé API reste côté serveur, jamais exposée au client.
// Utilise la couche d'abstraction api/_lib/ai-client.js — Gemini par défaut
// (gratuit), bascule vers Anthropic possible via AI_PROVIDER=anthropic.

import { callAI } from '../ai-client.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { messages, system } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // Limit conversation history to last 20 messages to avoid token bloat
    const trimmedMessages = messages.slice(-20);

    const { text } = await callAI({ system: system || '', messages: trimmedMessages, maxTokens: 1500 });

    // On garde le format de réponse "Anthropic-like" pour rester compatible
    // avec le frontend existant (data.content?.[0]?.text)
    return res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    console.error('Chat proxy error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
