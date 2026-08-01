// api/email.js — Regroupe toutes les routes /api/email/* en une seule fonction serverless.
import callback from './_lib/handlers/email/callback.js';
import connect from './_lib/handlers/email/connect.js';
import sync from './_lib/handlers/email/sync.js';

const routes = {
  'callback': callback,
  'connect': connect,
  'sync': sync,
};

export default async function handler(req, res) {
  const action = req.query.action;
  const target = routes[action];
  if (!target) return res.status(404).json({ error: `Route email/${action} introuvable` });
  return target(req, res);
}
