// api/brand.js — Regroupe toutes les routes /api/brand/* en une seule fonction serverless.
import applications from './_lib/handlers/brand/applications.js';
import briefAi from './_lib/handlers/brand/brief-ai.js';
import campaigns from './_lib/handlers/brand/campaigns.js';
import creators from './_lib/handlers/brand/creators.js';
import deliverables from './_lib/handlers/brand/deliverables.js';
import payments from './_lib/handlers/brand/payments.js';
import profile from './_lib/handlers/brand/profile.js';
import reporting from './_lib/handlers/brand/reporting.js';
import team from './_lib/handlers/brand/team.js';

const routes = {
  'applications': applications,
  'brief-ai': briefAi,
  'campaigns': campaigns,
  'creators': creators,
  'deliverables': deliverables,
  'payments': payments,
  'profile': profile,
  'reporting': reporting,
  'team': team,
};

export default async function handler(req, res) {
  const action = req.query.action;
  const target = routes[action];
  if (!target) return res.status(404).json({ error: `Route brand/${action} introuvable` });
  return target(req, res);
}
