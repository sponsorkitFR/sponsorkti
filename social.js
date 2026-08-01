// api/email/sync.js
// Le coeur du niveau 2 :
// 1. Lit les emails récents (Gmail / Outlook / IMAP)
// 2. Les compare aux deals existants (par email de contact ou nom de marque)
// 3. Envoie à Claude pour analyser le statut
// 4. Met à jour les deals automatiquement

import { createClient } from '@supabase/supabase-js';
import { callAI, extractJSON } from '../_lib/ai-client.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth — soit token user soit appel interne (depuis callback)
  let userId;
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) userId = user.id;
  }
  if (!userId && req.body?.userId) {
    userId = req.body.userId; // appel interne depuis callback OAuth
  }
  if (!userId) return res.status(401).json({ error: 'Non autorisé' });

  try {
    // 1. Récupérer les connexions email de l'utilisateur
    const { data: connections } = await supabase
      .from('email_connections')
      .select('*')
      .eq('user_id', userId);

    if (!connections || connections.length === 0) {
      return res.status(200).json({ ok: true, message: 'Aucune connexion email', changes: [] });
    }

    // 2. Récupérer les deals actifs du créateur (pas encore payés/annulés)
    const { data: deals } = await supabase
      .from('deals')
      .select('*')
      .eq('user_id', userId)
      .not('status', 'in', '("paid","cancelled")');

    if (!deals || deals.length === 0) {
      return res.status(200).json({ ok: true, message: 'Aucun deal actif à surveiller', changes: [] });
    }

    const allChanges = [];

    // 3. Pour chaque connexion email, lire les emails récents
    for (const conn of connections) {
      let emails = [];

      if (conn.provider === 'gmail') {
        emails = await fetchGmailEmails(conn, deals);
      } else if (conn.provider === 'outlook') {
        emails = await fetchOutlookEmails(conn, deals);
      } else if (conn.provider === 'imap') {
        emails = await fetchImapEmails(conn, deals);
      }

      if (emails.length === 0) continue;

      // 4. Pour chaque email pertinent, demander à l'IA d'analyser le statut
      for (const email of emails) {
        const deal = matchEmailToDeal(email, deals);
        if (!deal) continue;

        const analysis = await analyzeEmailWithAI(email, deal);
        if (!analysis.statusChange) continue;
        if (analysis.newStatus === deal.status) continue;

        // 5. Mettre à jour le deal
        const { data: updated } = await supabase
          .from('deals')
          .update({
            status: analysis.newStatus,
            notes: (deal.notes || '') + `\n\n[Auto-sync ${new Date().toLocaleDateString('fr')}] ${analysis.reason}`,
            updated_at: new Date().toISOString()
          })
          .eq('id', deal.id)
          .select().single();

        // 6. Créer une notification
        await supabase.from('notifications').insert({
          user_id: userId,
          type: 'deal_status_change',
          title: `${deal.brand} — statut mis à jour`,
          message: `${statusLabel(deal.status)} → ${statusLabel(analysis.newStatus)} · ${analysis.reason}`,
          deal_id: deal.id,
          read: false,
          created_at: new Date().toISOString()
        });

        allChanges.push({
          deal_id: deal.id,
          brand: deal.brand,
          old_status: deal.status,
          new_status: analysis.newStatus,
          reason: analysis.reason
        });
      }

      // Mettre à jour last_sync
      await supabase.from('email_connections')
        .update({ last_sync: new Date().toISOString() })
        .eq('id', conn.id);
    }

    return res.status(200).json({ ok: true, changes: allChanges });

  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── GMAIL ──────────────────────────────────────────────────────────────────
async function fetchGmailEmails(conn, deals) {
  // Rafraîchir le token si expiré
  const accessToken = await refreshGoogleToken(conn);
  if (!accessToken) return [];

  // Construire la query Gmail : emails des 7 derniers jours liés aux marques
  const brandEmails = deals.map(d => d.contact_email).filter(Boolean);
  const brandNames = deals.map(d => d.brand).join(' OR ');
  const since = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0].replace(/-/g, '/');
  const q = `after:${since} (${brandNames}${brandEmails.length ? ' OR from:(' + brandEmails.join(' OR ') + ')' : ''})`;

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30&q=${encodeURIComponent(q)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const list = await listRes.json();
  if (!list.messages) return [];

  const emails = [];
  for (const msg of list.messages.slice(0, 20)) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const full = await msgRes.json();
    const parsed = parseGmailMessage(full);
    if (parsed) emails.push(parsed);
  }
  return emails;
}

function parseGmailMessage(msg) {
  const headers = msg.payload?.headers || [];
  const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  const subject = get('Subject');
  const from = get('From');
  const date = get('Date');

  // Extraire le corps du message
  let body = '';
  const parts = msg.payload?.parts || [msg.payload];
  for (const part of parts) {
    if (part?.mimeType === 'text/plain' && part?.body?.data) {
      body = Buffer.from(part.body.data, 'base64').toString('utf-8').slice(0, 2000);
      break;
    }
  }
  if (!body && msg.snippet) body = msg.snippet;

  return { from, subject, body, date, source: 'gmail' };
}

async function refreshGoogleToken(conn) {
  if (!conn.refresh_token) return conn.access_token;
  const expiry = conn.token_expires_at ? new Date(conn.token_expires_at) : null;
  if (expiry && expiry > new Date(Date.now() + 60000)) return conn.access_token; // encore valide

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (data.access_token) {
    await supabase.from('email_connections').update({
      access_token: data.access_token,
      token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString()
    }).eq('id', conn.id);
    return data.access_token;
  }
  return conn.access_token;
}

// ── OUTLOOK ────────────────────────────────────────────────────────────────
async function fetchOutlookEmails(conn, deals) {
  const accessToken = await refreshMicrosoftToken(conn);
  if (!accessToken) return [];

  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const brandNames = deals.map(d => d.brand).join("' or contains(subject,'");
  const filter = `receivedDateTime ge ${since} and (contains(subject,'${brandNames}'))`;

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$top=30&$filter=${encodeURIComponent(filter)}&$select=from,subject,body,receivedDateTime`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!data.value) return [];

  return data.value.map(msg => ({
    from: msg.from?.emailAddress?.address || '',
    subject: msg.subject || '',
    body: msg.body?.content?.replace(/<[^>]+>/g, '').slice(0, 2000) || '',
    date: msg.receivedDateTime,
    source: 'outlook'
  }));
}

async function refreshMicrosoftToken(conn) {
  if (!conn.refresh_token) return conn.access_token;
  const expiry = conn.token_expires_at ? new Date(conn.token_expires_at) : null;
  if (expiry && expiry > new Date(Date.now() + 60000)) return conn.access_token;

  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Mail.Read offline_access'
    })
  });
  const data = await res.json();
  if (data.access_token) {
    await supabase.from('email_connections').update({
      access_token: data.access_token,
      token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString()
    }).eq('id', conn.id);
    return data.access_token;
  }
  return conn.access_token;
}

// ── IMAP UNIVERSEL ─────────────────────────────────────────────────────────
async function fetchImapEmails(conn, deals) {
  // Pour IMAP on utilise une lib Node.js — imapflow
  // Elle est installée via package.json
  try {
    const { ImapFlow } = await import('imapflow');
    const password = Buffer.from(conn.credentials_encrypted, 'base64').toString('utf-8');

    const client = new ImapFlow({
      host: conn.imap_host,
      port: conn.imap_port || 993,
      secure: conn.imap_tls !== false,
      auth: { user: conn.email, pass: password },
      logger: false
    });

    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const emails = [];

    try {
      const since = new Date(Date.now() - 7 * 86400000);
      for await (const msg of client.fetch({ since }, { envelope: true, bodyStructure: true, source: true })) {
        const from = msg.envelope?.from?.[0]?.address || '';
        const subject = msg.envelope?.subject || '';
        const body = msg.source?.toString().slice(0, 2000) || '';
        // Filtrer uniquement les emails liés aux marques
        const relevant = deals.some(d =>
          (d.contact_email && from.includes(d.contact_email.split('@')[1])) ||
          subject.toLowerCase().includes(d.brand.toLowerCase())
        );
        if (relevant) emails.push({ from, subject, body, date: msg.envelope?.date, source: 'imap' });
        if (emails.length >= 20) break;
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return emails;
  } catch (err) {
    console.error('IMAP error:', err.message);
    return [];
  }
}

// ── MATCHING EMAIL → DEAL ──────────────────────────────────────────────────
function matchEmailToDeal(email, deals) {
  for (const deal of deals) {
    // Match par email de contact
    if (deal.contact_email && email.from.toLowerCase().includes(deal.contact_email.split('@')[1]?.toLowerCase())) {
      return deal;
    }
    // Match par nom de marque dans le sujet
    if (email.subject.toLowerCase().includes(deal.brand.toLowerCase())) {
      return deal;
    }
    // Match par nom de marque dans le corps
    if (email.body.toLowerCase().includes(deal.brand.toLowerCase())) {
      return deal;
    }
  }
  return null;
}

// ── ANALYSE IA ─────────────────────────────────────────────────────────────
async function analyzeEmailWithAI(email, deal) {
  const prompt = `Tu es un assistant qui analyse des emails de partenariat entre un créateur de contenu et une marque.

Deal actuel :
- Marque : ${deal.brand}
- Statut actuel : ${deal.status}
- Montant : ${deal.amount}€
- Format : ${deal.format}

Email reçu :
- De : ${email.from}
- Sujet : ${email.subject}
- Corps : ${email.body.slice(0, 800)}

Les statuts possibles sont :
- prospect : premier contact, pas encore de réponse
- negotiation : discussions en cours, intérêt confirmé
- signed : accord conclu, contrat ou confirmation écrite
- ongoing : contenu en cours de production/livraison
- paid : paiement reçu
- ghost : plus de réponse depuis longtemps
- cancelled : annulé

Réponds UNIQUEMENT en JSON valide, sans texte autour :
{
  "statusChange": true ou false,
  "newStatus": "le_nouveau_statut",
  "confidence": 0.0 à 1.0,
  "reason": "explication courte en français (max 100 caractères)"
}

Ne change le statut que si tu es sûr à plus de 70% (confidence > 0.7). Si l'email est ambigu, mets statusChange: false.`;

  try {
    const { text } = await callAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 200, json: true });
    const result = extractJSON(text) || { statusChange: false };
    if (result.confidence < 0.7) result.statusChange = false;
    return result;
  } catch {
    return { statusChange: false };
  }
}

function statusLabel(s) {
  const labels = { prospect:'Prospect', negotiation:'Négociation', signed:'Signé', ongoing:'En cours', paid:'Payé', ghost:'Ghost', cancelled:'Annulé' };
  return labels[s] || s;
}
