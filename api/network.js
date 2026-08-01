// api/network.js — Regroupe toutes les routes /api/network/* en une seule fonction serverless.
import feed from './_lib/handlers/network/feed.js';
import profile from './_lib/handlers/network/profile.js';
import search from './_lib/handlers/network/search.js';

const routes = {
  'feed': feed,
  'profile': profile,
  'search': search,
};

export default async function handler(req, res) {
  const action = req.query.action;
  const target = routes[action];
  if (!target) return res.status(404).json({ error: `Route network/${action} introuvable` });
  return target(req, res);
}
