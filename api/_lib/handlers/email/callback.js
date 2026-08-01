// api/email/callback.js
// Reçoit le code OAuth de Google/Microsoft, échange contre un token, stocke en BDD

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  const { code, state: userId, provider, error: oauthError } = req.query;

  if (oauthError) {
    return res.redirect(`${process.env.APP_URL}/?email_error=${oauthError}`);
  }
  if (!code || !userId || !provider) {
    return res.redirect(`${process.env.APP_URL}/?email_error=missing_params`);
  }

  try {
    let tokenData, userEmail;

    // ── GMAIL ──────────────────────────────────────────────────────────────
    if (provider === 'gmail') {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${process.env.APP_URL}/api/email/callback?provider=gmail`,
          grant_type: 'authorization_code'
        })
      });
      tokenData = await tokenRes.json();
      if (tokenData.error) throw new Error(tokenData.error_description);

      // Récupérer l'email de l'utilisateur
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const profile = await profileRes.json();
      userEmail = profile.email;
    }

    // ── OUTLOOK ────────────────────────────────────────────────────────────
    if (provider === 'outlook') {
      const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.MICROSOFT_CLIENT_ID,
          client_secret: process.env.MICROSOFT_CLIENT_SECRET,
          redirect_uri: `${process.env.APP_URL}/api/email/callback?provider=outlook`,
          grant_type: 'authorization_code',
          scope: 'https://graph.microsoft.com/Mail.Read offline_access User.Read'
        })
      });
      tokenData = await tokenRes.json();
      if (tokenData.error) throw new Error(tokenData.error_description);

      const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const profile = await profileRes.json();
      userEmail = profile.mail || profile.userPrincipalName;
    }

    // ── STOCKER LES TOKENS ─────────────────────────────────────────────────
    await supabase.from('email_connections').upsert({
      user_id: userId,
      provider,
      email: userEmail,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      token_expires_at: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : null,
      connected_at: new Date().toISOString(),
      last_sync: null
    }, { onConflict: 'user_id,provider' });

    // Lancer un premier scan immédiat
    await fetch(`${process.env.APP_URL}/api/email/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, provider })
    }).catch(() => {}); // fire & forget

    return res.redirect(`${process.env.APP_URL}/?email_connected=${provider}`);

  } catch (err) {
    console.error('OAuth callback error:', err);
    return res.redirect(`${process.env.APP_URL}/?email_error=${encodeURIComponent(err.message)}`);
  }
}
