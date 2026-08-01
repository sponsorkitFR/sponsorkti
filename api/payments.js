// api/payments.js — Regroupe toutes les routes /api/payments/* en une seule fonction serverless.
import paypal from './_lib/handlers/payments/paypal.js';
import stripe from './_lib/handlers/payments/stripe.js';

const routes = {
  'paypal': paypal,
  'stripe': stripe,
};

export default async function handler(req, res) {
  const action = req.query.action;
  const target = routes[action];
  if (!target) return res.status(404).json({ error: `Route payments/${action} introuvable` });
  return target(req, res);
}
