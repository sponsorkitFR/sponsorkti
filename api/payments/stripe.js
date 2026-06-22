// api/payments/stripe.js
// Webhook Stripe — détecte les paiements entrants et passe les deals à "paid"

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Désactiver le bodyParser pour lire le raw body (nécessaire pour la signature Stripe)
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // 1. Lire le raw body pour vérifier la signature
  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  // 2. Vérifier la signature Stripe (sécurité critique)
  let event;
  try {
    event = verifyStripeSignature(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature invalide:', err.message);
    return res.status(400).json({ error: 'Signature invalide' });
  }

  // 3. Traiter uniquement les paiements reçus
  if (event.type === 'payment_intent.succeeded' || event.type === 'charge.succeeded') {
    await handlePaymentReceived(event.data.object);
  }

  // 4. Répondre immédiatement à Stripe (important — délai max 30s)
  return res.status(200).json({ received: true });
}

async function handlePaymentReceived(paymentObject) {
  const amount = (paymentObject.amount || paymentObject.amount_received || 0) / 100; // centimes → euros
  const currency = paymentObject.currency?.toUpperCase() || 'EUR';
  const description = paymentObject.description || '';
  const metadata = paymentObject.metadata || {};
  const customerEmail = paymentObject.receipt_email || paymentObject.billing_details?.email || '';

  console.log(`💰 Paiement Stripe reçu: ${amount}${currency} — ${description} — ${customerEmail}`);

  // 4a. Chercher le deal correspondant dans TOUS les comptes utilisateurs
  // On cherche par montant + nom de marque dans description
  const { data: deals } = await supabase
    .from('deals')
    .select('*, profiles!inner(email)')
    .in('status', ['signed', 'ongoing'])
    .gte('amount', amount * 0.9)  // tolérance ±10% (acomptes, etc.)
    .lte('amount', amount * 1.1);

  if (!deals || deals.length === 0) {
    console.log('Aucun deal correspondant trouvé pour ce paiement');
    return;
  }

  // 4b. Affiner le matching par description ou email
  let matchedDeal = null;
  for (const deal of deals) {
    const descLower = description.toLowerCase();
    const brandLower = deal.brand.toLowerCase();
    const emailMatch = customerEmail && deal.contact_email &&
      customerEmail.toLowerCase().includes(deal.contact_email.split('@')[1]?.toLowerCase());
    const brandMatch = descLower.includes(brandLower) || metadata.brand === deal.brand;

    if (emailMatch || brandMatch) {
      matchedDeal = deal;
      break;
    }
  }

  // Si un seul deal correspond au montant exact, on l'utilise
  if (!matchedDeal && deals.length === 1) {
    matchedDeal = deals[0];
  }

  if (!matchedDeal) {
    console.log('Paiement reçu mais impossible de matcher un deal précis');
    return;
  }

  // 4c. Mettre à jour le deal → Payé
  await supabase.from('deals').update({
    status: 'paid',
    notes: (matchedDeal.notes || '') + `\n\n[Stripe ${new Date().toLocaleDateString('fr')}] Paiement de ${amount}${currency} confirmé automatiquement.`,
    updated_at: new Date().toISOString()
  }).eq('id', matchedDeal.id);

  // 4d. Notification utilisateur
  await supabase.from('notifications').insert({
    user_id: matchedDeal.user_id,
    type: 'payment_received',
    title: `💰 Paiement reçu — ${matchedDeal.brand}`,
    message: `${amount} ${currency} confirmé par Stripe. Deal marqué comme Payé.`,
    deal_id: matchedDeal.id,
    read: false,
    created_at: new Date().toISOString()
  });

  console.log(`✅ Deal ${matchedDeal.brand} passé à "paid" — ${amount}${currency}`);
}

// Vérification signature Stripe (sans SDK pour garder les dépendances minimales)
function verifyStripeSignature(rawBody, sig, secret) {
  if (!sig || !secret) throw new Error('Signature ou secret manquant');
  const parts = sig.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});

  const timestamp = parts.t;
  const signatures = sig.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));

  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  if (!signatures.includes(expected)) throw new Error('Signature ne correspond pas');

  // Vérifier que le webhook a moins de 5 minutes (protection replay)
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    throw new Error('Webhook trop ancien');
  }

  return JSON.parse(rawBody);
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
