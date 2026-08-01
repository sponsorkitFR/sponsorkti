// api/email/connect.js
// Génère les URLs OAuth pour Gmail et Outlook, ou valide les credentials IMAP

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth utilisateur
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token requis' });
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token invalide' });

  // GET — générer URL OAuth ou statut connexion
  if (req.method === 'GET') {
    const { provider } = req.query;

    if (provider === 'gmail') {
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: `${process.env.APP_URL}/api/email/callback?provider=gmail`,
        response_type: 'code',
        scope: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/userinfo.email'
        ].join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state: user.id // passer l'user_id pour le callback
      });
      return res.status(200).json({
        url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`
      });
    }

    if (provider === 'outlook') {
      const params = new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID,
        redirect_uri: `${process.env.APP_URL}/api/email/callback?provider=outlook`,
        response_type: 'code',
        scope: 'https://graph.microsoft.com/Mail.Read offline_access User.Read',
        state: user.id
      });
      return res.status(200).json({
        url: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`
      });
    }

    // Statut connexions de l'utilisateur
    const { data } = await supabase
      .from('email_connections')
      .select('provider, email, connected_at, last_sync')
      .eq('user_id', user.id);

    return res.status(200).json({ connections: data || [] });
  }

  // POST — connexion IMAP universelle
  if (req.method === 'POST') {
    const { host, port, email, password, tls } = req.body;
    if (!host || !email || !password) {
      return res.status(400).json({ error: 'host, email et password requis' });
    }

    // Chiffrer le mot de passe avant stockage
    const encrypted = Buffer.from(password).toString('base64'); // En prod : utiliser crypto AES

    const { error } = await supabase.from('email_connections').upsert({
      user_id: user.id,
      provider: 'imap',
      email,
      imap_host: host,
      imap_port: port || 993,
      imap_tls: tls !== false,
      credentials_encrypted: encrypted,
      connected_at: new Date().toISOString()
    }, { onConflict: 'user_id,provider' });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, message: 'Connexion IMAP enregistrée' });
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
}
