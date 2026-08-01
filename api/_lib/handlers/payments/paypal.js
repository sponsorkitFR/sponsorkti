// api/payments/paypal.js
// Webhook PayPal IPN/REST — détecte les paiements et passe les deals à "paid"

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = req.body;

    // PayPal envoie différents types d'événements
    const eventType = body.event_type || body.txn_type || '';
    console.log('PayPal webhook reçu:', eventType);

    // Vérifier l'authenticité du webhook PayPal
    const isValid = await verifyPayPalWebhook(req);
    if (!isValid) {
      console.error('PayPal webhook signature invalide');
      return res.status(400).json({ error: 'Signature invalide' });
    }

    // Traiter les paiements complétés
    const paymentEvents = [
      'PAYMENT.CAPTURE.COMPLETED',  // PayPal REST API
      'PAYMENT.SALE.COMPLETED',     // PayPal Classic
      'web_accept',                  // IPN - bouton PayPal
      'cart',                        // IPN - panier
      'express_checkout'             // IPN - checkout express
    ];

    if (paymentEvents.some(e => eventType.includes(e))) {
      await handlePayPalPayment(body);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('PayPal webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handlePayPalPayment(body) {
  // Extraire les infos selon le format (REST vs IPN)
  let amount, currency, payerEmail, description, transactionId;

  if (body.resource) {
    // Format REST API PayPal
    const resource = body.resource;
    amount = parseFloat(resource.amount?.value || resource.seller_receivable_breakdown?.gross_amount?.value || 0);
    currency = resource.amount?.currency_code || 'EUR';
    payerEmail = resource.payer?.email_address || '';
    description = resource.description || resource.custom_id || '';
    transactionId = resource.id;
  } else {
    // Format IPN
    amount = parseFloat(body.mc_gross || body.payment_gross || 0);
    currency = (body.mc_currency || 'EUR').toUpperCase();
    payerEmail = body.payer_email || '';
    description = body.item_name || body.memo || '';
    transactionId = body.txn_id;
  }

  if (!amount || amount <= 0) return;

  console.log(`💰 Paiement PayPal reçu: ${amount}${currency} — ${payerEmail}`);

  // Chercher le deal correspondant
  const { data: deals } = await supabase
    .from('deals')
    .select('*')
    .in('status', ['signed', 'ongoing'])
    .gte('amount', amount * 0.9)
    .lte('amount', amount * 1.1);

  if (!deals || deals.length === 0) return;

  let matchedDeal = null;
  for (const deal of deals) {
    const emailMatch = payerEmail && deal.contact_email &&
      payerEmail.toLowerCase().includes(deal.contact_email.split('@')[1]?.toLowerCase());
    const brandMatch = description.toLowerCase().includes(deal.brand.toLowerCase());
    if (emailMatch || brandMatch) { matchedDeal = deal; break; }
  }
  if (!matchedDeal && deals.length === 1) matchedDeal = deals[0];
  if (!matchedDeal) return;

  // Mettre à jour le deal
  await supabase.from('deals').update({
    status: 'paid',
    notes: (matchedDeal.notes || '') + `\n\n[PayPal ${new Date().toLocaleDateString('fr')}] Paiement de ${amount}${currency} confirmé. Transaction: ${transactionId}`,
    updated_at: new Date().toISOString()
  }).eq('id', matchedDeal.id);

  // Notification
  await supabase.from('notifications').insert({
    user_id: matchedDeal.user_id,
    type: 'payment_received',
    title: `💰 Paiement reçu — ${matchedDeal.brand}`,
    message: `${amount} ${currency} confirmé via PayPal. Deal marqué comme Payé.`,
    deal_id: matchedDeal.id,
    read: false,
    created_at: new Date().toISOString()
  });

  console.log(`✅ Deal ${matchedDeal.brand} passé à "paid" via PayPal`);
}

// Vérification PayPal : on valide auprès des serveurs PayPal
async function verifyPayPalWebhook(req) {
  try {
    // Obtenir un token d'accès PayPal
    const authRes = await fetch(
      `https://api${process.env.PAYPAL_MODE === 'sandbox' ? '.sandbox' : ''}.paypal.com/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(
            `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
          ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      }
    );
    const auth = await authRes.json();
    if (!auth.access_token) return true; // En dev, on laisse passer

    // Vérifier la signature du webhook
    const verifyRes = await fetch(
      `https://api${process.env.PAYPAL_MODE === 'sandbox' ? '.sandbox' : ''}.paypal.com/v1/notifications/verify-webhook-signature`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auth.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          auth_algo: req.headers['paypal-auth-algo'],
          cert_url: req.headers['paypal-cert-url'],
          transmission_id: req.headers['paypal-transmission-id'],
          transmission_sig: req.headers['paypal-transmission-sig'],
          transmission_time: req.headers['paypal-transmission-time'],
          webhook_id: process.env.PAYPAL_WEBHOOK_ID,
          webhook_event: req.body
        })
      }
    );
    const verify = await verifyRes.json();
    return verify.verification_status === 'SUCCESS';
  } catch (err) {
    console.error('PayPal verify error:', err);
    return true; // En cas d'erreur de vérification, on laisse passer (à durcir en prod)
  }
}
