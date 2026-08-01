// api/misc.js — Regroupe les routes restantes (chat, deals, events, profile, stats,
// messages/inbox, collab/request) en une seule fonction serverless.
import chat from './_lib/handlers/chat.js';
import deals from './_lib/handlers/deals.js';
import events from './_lib/handlers/events.js';
import profile from './_lib/handlers/profile.js';
import stats from './_lib/handlers/stats.js';
import messagesInbox from './_lib/handlers/messages/inbox.js';
import collabRequest from './_lib/handlers/collab/request.js';

const routes = {
  'chat': chat,
  'deals': deals,
  'events': events,
  'profile': profile,
  'stats': stats,
  'messages-inbox': messagesInbox,
  'collab-request': collabRequest,
};

export default async function handler(req, res) {
  const action = req.query.action;
  const target = routes[action];
  if (!target) return res.status(404).json({ error: `Route ${action} introuvable` });
  return target(req, res);
}
