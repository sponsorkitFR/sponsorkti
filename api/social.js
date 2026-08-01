// api/social.js — Regroupe toutes les routes /api/social/* en une seule fonction serverless.
import callback from './_lib/handlers/social/callback.js';
import connect from './_lib/handlers/social/connect.js';
import disconnect from './_lib/handlers/social/disconnect.js';
import sync from './_lib/handlers/social/sync.js';

const routes = {
  'callback': callback,
  'connect': connect,
  'disconnect': disconnect,
  'sync': sync,
};

export default async function handler(req, res) {
  const action = req.query.action;
  const target = routes[action];
  if (!target) return res.status(404).json({ error: `Route social/${action} introuvable` });
  return target(req, res);
}
