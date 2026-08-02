// api/ai/run-automations.js — Tâche planifiée (cron quotidien)
//
// Conçu pour être appelé par un cron (ex: Vercel Cron, GitHub Actions, ou
// un scheduler externe) une fois par jour. Pour chaque utilisateur, exécute
// UNIQUEMENT les automatisations qu'il a activées dans automation_settings.
// Chaque exécution est journalisée dans automation_logs.
//
// Sécurité : protégé par un header x-cron-secret == process.env.CRON_SECRET

import { createClient } from '@supabase/supabase-js';
import { callAI, extractJSON } from '../../ai-client.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { data: settingsRows, error } = await supabase.from('automation_settings').select('*');
    if (error) throw error;

    const results = [];
    for (const settings of settingsRows || []) {
      const userResult = { user_id: settings.user_id, ran: [] };

      if (settings.auto_followup) {
        userResult.ran.push(await runFollowupTask(settings));
      }
      if (settings.auto_pricing_alert) {
        userResult.ran.push(await runPricingAlertTask(settings));
      }
      if (settings.auto_sponsor_scan) {
        userResult.ran.push(await runSponsorScanTask(settings));
      }
      if (settings.auto_deadline_alerts) {
        userResult.ran.push(await runDeadlineAlertTask(settings));
      }
      if (settings.auto_negotiation_tips) {
        userResult.ran.push(await runNegotiationTipsTask(settings));
      }
      if (settings.auto_weekly_report && isWeeklyReportDay()) {
        userResult.ran.push(await runWeeklyReportTask(settings));
      }
      // auto_deal_detection et auto_payment_tracking sont déclenchés par les
      // webhooks email/Stripe/PayPal (voir api/email/sync.js et api/payments/*),
      // pas par ce cron — ils sont vérifiés ici uniquement pour le statut.

      results.push(userResult);
    }

    return res.status(200).json({ processed: results.length, results });
  } catch (err) {
    console.error('Automation runner error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── TÂCHE : relances automatiques des deals "ghost" ───────────────────
async function runFollowupTask(settings) {
  const userId = settings.user_id;
  const minDays = settings.auto_followup_days || 7;

  const { data: ghosts } = await supabase
    .from('deals').select('*').eq('user_id', userId).eq('status', 'ghost');

  const eligible = (ghosts || []).filter(d => {
    const days = d.last_contact_days || daysSince(d.updated_at || d.created_at);
    return days >= minDays;
  });

  if (eligible.length === 0) {
    return log(userId, 'auto_followup', 'skipped', 'Aucun deal ghost éligible à relancer.');
  }

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', userId).single();
  const drafts = [];
  for (const deal of eligible) {
    const text = await generateFollowupEmail(profile, deal);
    drafts.push({ deal_id: deal.id, brand: deal.brand, draft: text });
    // Stocke le brouillon dans ai_conversations pour que l'utilisateur le retrouve dans son chat
    await supabase.from('ai_conversations').insert({
      user_id: userId, agent: 'followup', role: 'assistant',
      content: `[Automatisation] Brouillon de relance pour ${deal.brand} :\n\n${text}`,
      metadata: { deal_id: deal.id, automated: true }
    });
  }

  return log(userId, 'auto_followup', 'success', `${drafts.length} brouillon(s) de relance généré(s).`, { drafts });
}

// ── TÂCHE : alerte si le tarif d'un deal est sous le marché ────────────
async function runPricingAlertTask(settings) {
  const userId = settings.user_id;
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (!profile || !profile.subscribers) return log(userId, 'auto_pricing_alert', 'skipped', 'Profil incomplet.');

  const { data: openDeals } = await supabase
    .from('deals').select('*').eq('user_id', userId).in('status', ['negotiation', 'proposed']);

  if (!openDeals || openDeals.length === 0) {
    return log(userId, 'auto_pricing_alert', 'skipped', 'Aucun deal ouvert à analyser.');
  }

  const eng = profile.engagement_rate || 2.5;
  const views = profile.avg_views || profile.subscribers * 0.3;
  const cpmBase = 8 + (eng - 2) * 1.5;
  const marketRate = (views / 1000) * cpmBase;

  const underpriced = openDeals.filter(d => d.amount && d.amount < marketRate * 0.7);
  if (underpriced.length === 0) {
    return log(userId, 'auto_pricing_alert', 'success', 'Tous les deals ouverts sont dans la fourchette du marché.');
  }

  for (const d of underpriced) {
    await supabase.from('notifications').insert({
      user_id: userId,
      type: 'pricing_alert',
      title: `Tarif sous le marché — ${d.brand}`,
      body: `${d.amount}€ proposé alors que ton tarif marché estimé est ~${Math.round(marketRate)}€. Négocie une revalorisation avant de signer.`
    }).select().single().then(() => {}).catch(() => {});
  }

  return log(userId, 'auto_pricing_alert', 'success', `${underpriced.length} deal(s) sous le marché détecté(s).`, { underpriced: underpriced.map(d => d.brand) });
}

// ── TÂCHE : veille + matching sponsors quotidien ───────────────────────
async function runSponsorScanTask(settings) {
  const userId = settings.user_id;
  // Réutilise la même logique que api/ai/sponsors.js mais simplifié pour le cron :
  // on ne régénère que si aucun match "new" n'existe déjà depuis < 7 jours.
  const { data: recent } = await supabase
    .from('sponsor_matches').select('id, created_at').eq('user_id', userId).eq('status', 'new')
    .order('created_at', { ascending: false }).limit(1);

  if (recent && recent.length > 0 && daysSince(recent[0].created_at) < 7) {
    return log(userId, 'auto_sponsor_scan', 'skipped', 'Matching déjà récent (< 7 jours).');
  }

  // Appel interne au moteur de matching via fetch (réutilise la route existante)
  try {
    const base = process.env.PUBLIC_BASE_URL || '';
    const { data: { user } } = await supabase.auth.admin.getUserById(userId);
    if (!user) return log(userId, 'auto_sponsor_scan', 'error', 'Utilisateur introuvable.');

    // Pas de session token côté cron : on appelle directement la logique via
    // une fonction interne plutôt qu'un fetch HTTP authentifié.
    const matches = await computeSponsorMatches(userId);
    return log(userId, 'auto_sponsor_scan', 'success', `${matches.length} nouveaux sponsors matchés.`, { count: matches.length });
  } catch (e) {
    return log(userId, 'auto_sponsor_scan', 'error', e.message);
  }
}

// Logique de matching réutilisable (identique à api/ai/sponsors.js, factorisée ici)
async function computeSponsorMatches(userId) {
  const [{ data: profile }, { data: deals }, { data: memories }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).single(),
    supabase.from('deals').select('*').eq('user_id', userId),
    supabase.from('ai_memory').select('category,content').eq('user_id', userId)
  ]);
  if (!profile) return [];

  const subs = profile.subscribers || 0;
  const niche = (profile.niche || 'tech').toLowerCase();
  const alreadyWorkedWith = (deals || []).map(d => (d.brand || '').toLowerCase());

  const { data: candidates } = await supabase
    .from('sponsor_database').select('*').eq('active', true)
    .lte('min_subs', Math.max(subs, 1)).or(`max_subs.is.null,max_subs.gte.${subs}`);

  const filtered = (candidates || []).filter(c => {
    const alreadyDone = alreadyWorkedWith.includes((c.brand_name || '').toLowerCase());
    const nicheMatch = (c.niches || []).some(n => n.toLowerCase() === niche || niche.includes(n.toLowerCase()) || n.toLowerCase().includes(niche));
    return !alreadyDone && nicheMatch;
  });
  const pool = filtered.length > 0 ? filtered : (candidates || []).filter(c => !alreadyWorkedWith.includes((c.brand_name || '').toLowerCase()));
  if (pool.length === 0) return [];

  const totalRevenue = (deals || []).reduce((s, d) => s + (d.amount || 0), 0);
  const avgDeal = deals && deals.length > 0 ? Math.round(totalRevenue / deals.length) : 0;
  const memoryBlock = (memories || []).length > 0 ? `\nPréférences connues :\n${memories.map(m => `- [${m.category}] ${m.content}`).join('\n')}` : '';

  const prompt = `Profil créateur : niche ${profile.niche || '?'}, ${subs.toLocaleString()} abonnés, ${profile.engagement_rate || '?'}% engagement, deal moyen ${avgDeal}€. Marques déjà travaillées : ${alreadyWorkedWith.join(', ') || 'aucune'}.${memoryBlock}

Sponsors potentiels : ${JSON.stringify(pool.map(p => ({ id: p.id, brand_name: p.brand_name, sector: p.sector, niches: p.niches, budget_min: p.budget_min, budget_max: p.budget_max, formats: p.formats, notes: p.notes })))}

Sélectionne les 5 meilleurs matchs. JSON uniquement : [{"id":"...","score":0-100,"reasoning":"...","suggested_rate":1234}]`;

  let ranked = [];
  try {
    const { text } = await callAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 1200, json: true });
    ranked = extractJSON(text) || [];
  } catch (e) {
    console.error('computeSponsorMatches AI error:', e);
    return [];
  }

  const rows = ranked.filter(r => pool.some(p => p.id === r.id)).map(r => ({
    user_id: userId, sponsor_id: r.id,
    match_score: Math.max(0, Math.min(100, Math.round(r.score || 0))),
    reasoning: r.reasoning || '', suggested_rate: Math.round(r.suggested_rate || 0), status: 'new'
  }));
  if (rows.length > 0) await supabase.from('sponsor_matches').insert(rows);
  return rows;
}

// ── TÂCHE : alertes deadlines proches (< 3 jours) ───────────────────────
async function runDeadlineAlertTask(settings) {
  const userId = settings.user_id;
  const { data: deals } = await supabase.from('deals').select('*').eq('user_id', userId)
    .not('deadline', 'is', null).not('status', 'eq', 'paid');

  const soon = (deals || []).filter(d => {
    const days = Math.ceil((new Date(d.deadline) - new Date()) / 86400000);
    return days >= 0 && days <= 3;
  });

  if (soon.length === 0) return log(userId, 'auto_deadline_alerts', 'skipped', 'Aucune deadline imminente.');

  for (const d of soon) {
    await supabase.from('notifications').insert({
      user_id: userId, type: 'deadline_alert',
      title: `Deadline imminente — ${d.brand}`,
      body: `Le deal "${d.brand}" arrive à échéance le ${d.deadline}.`
    }).select().single().then(() => {}).catch(() => {});
  }
  return log(userId, 'auto_deadline_alerts', 'success', `${soon.length} alerte(s) deadline envoyée(s).`);
}

// ── TÂCHE : conseils de négociation proactifs sur deals en cours ───────
async function runNegotiationTipsTask(settings) {
  const userId = settings.user_id;
  const { data: negos } = await supabase.from('deals').select('*').eq('user_id', userId).eq('status', 'negotiation');
  if (!negos || negos.length === 0) return log(userId, 'auto_negotiation_tips', 'skipped', 'Aucune négociation en cours.');

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', userId).single();
  let count = 0;
  for (const d of negos) {
    const tip = await generateNegotiationTip(profile, d);
    await supabase.from('ai_conversations').insert({
      user_id: userId, agent: 'negotiator', role: 'assistant',
      content: `[Automatisation] Conseil de négociation — ${d.brand} (${(d.amount||0).toLocaleString()}€) :\n\n${tip}`,
      metadata: { deal_id: d.id, automated: true }
    });
    count++;
  }
  return log(userId, 'auto_negotiation_tips', 'success', `${count} conseil(s) de négociation généré(s).`);
}

// ── TÂCHE : rapport hebdomadaire (s'exécute le lundi) ───────────────────
async function runWeeklyReportTask(settings) {
  const userId = settings.user_id;
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', userId).single();
  const { data: deals } = await supabase.from('deals').select('*').eq('user_id', userId);

  const total = (deals || []).reduce((s, d) => s + (d.amount || 0), 0);
  const paid = (deals || []).filter(d => d.status === 'paid').reduce((s, d) => s + (d.amount || 0), 0);
  const active = (deals || []).filter(d => ['signed', 'negotiation', 'ongoing'].includes(d.status)).length;
  const ghosts = (deals || []).filter(d => d.status === 'ghost').length;

  const prompt = `Génère un rapport hebdomadaire court (4-6 phrases) pour ce créateur :
- Niche : ${profile?.niche || '?'}
- Pipeline total : ${total.toLocaleString()}€
- Perçu : ${paid.toLocaleString()}€
- Deals actifs : ${active}, ghosts : ${ghosts}

Structure : 1) résumé de la semaine, 2) priorité n°1 pour la semaine prochaine, 3) une opportunité à ne pas manquer. Réponds en français, ton encourageant mais factuel.`;

  let report = '';
  try {
    const result = await callAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 500 });
    report = result.text;
  } catch (e) { console.error('Weekly report AI error:', e); }

  await supabase.from('ai_conversations').insert({
    user_id: userId, agent: 'analyst', role: 'assistant',
    content: `[Rapport hebdomadaire] ${report}`, metadata: { automated: true, type: 'weekly_report' }
  });
  await supabase.from('notifications').insert({
    user_id: userId, type: 'weekly_report', title: 'Ton rapport hebdomadaire est prêt', body: report.slice(0, 200)
  }).select().single().then(() => {}).catch(() => {});

  return log(userId, 'auto_weekly_report', 'success', 'Rapport hebdomadaire généré.');
}

// ── Helpers ──────────────────────────────────────────────────────────
async function generateFollowupEmail(profile, deal) {
  const days = deal.last_contact_days || daysSince(deal.updated_at || deal.created_at);
  const tone = days > 21 ? 'dernier rappel poli mais ferme' : days > 14 ? 'direct et orienté action' : 'amical et léger';
  const prompt = `Rédige un court email de relance (80-120 mots) pour ${deal.brand}, sans réponse depuis ${days} jours. Ton : ${tone}. Créateur : ${profile?.subscribers?.toLocaleString() || '?'} abonnés, niche ${profile?.niche || '?'}. Réponds uniquement avec l'email (objet + corps), en français.`;
  try {
    const { text } = await callAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 400 });
    return text;
  } catch (e) {
    console.error('generateFollowupEmail AI error:', e);
    return '';
  }
}

async function generateNegotiationTip(profile, deal) {
  const prompt = `Le créateur (${profile?.subscribers?.toLocaleString() || '?'} abonnés, ${profile?.engagement_rate || '?'}% engagement) est en négociation avec ${deal.brand} pour ${(deal.amount||0).toLocaleString()}€ (${deal.format || 'deal'}). Donne 1 conseil concret et actionnable pour faire avancer cette négociation, en 2-3 phrases, en français.`;
  try {
    const { text } = await callAI({ messages: [{ role: 'user', content: prompt }], maxTokens: 300 });
    return text;
  } catch (e) {
    console.error('generateNegotiationTip AI error:', e);
    return '';
  }
}

function daysSince(dateStr) {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function isWeeklyReportDay() {
  return new Date().getDay() === 1; // lundi
}

async function log(userId, task, status, summary, result = {}) {
  await supabase.from('automation_logs').insert({ user_id: userId, task, status, summary, result });
  return { task, status, summary };
}
