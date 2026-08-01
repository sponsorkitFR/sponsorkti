// api/ai.js — Regroupe toutes les routes /api/ai/* en une seule fonction serverless
// (nécessaire car le plan gratuit Vercel limite le nombre de fonctions).
// Chaque route d'origine est appelée via ?action=xxx, ajouté automatiquement par vercel.json.

import agentChat from './_lib/handlers/ai/agent-chat.js';
import automationSettings from './_lib/handlers/ai/automation-settings.js';
import memory from './_lib/handlers/ai/memory.js';
import runAutomations from './_lib/handlers/ai/run-automations.js';
import sponsorMatchStatus from './_lib/handlers/ai/sponsor-match-status.js';
import sponsors from './_lib/handlers/ai/sponsors.js';

const routes = {
  'agent-chat': agentChat,
  'automation-settings': automationSettings,
  'memory': memory,
  'run-automations': runAutomations,
  'sponsor-match-status': sponsorMatchStatus,
  'sponsors': sponsors,
};

export default async function handler(req, res) {
  const action = req.query.action;
  const target = routes[action];
  if (!target) return res.status(404).json({ error: `Route ai/${action} introuvable` });
  return target(req, res);
}
