// api/stats.js — Expose les statistiques agrégées au dashboard admin

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Protection basique par clé admin
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const day7ago = new Date(now - 7 * 86400000).toISOString();
    const day30ago = new Date(now - 30 * 86400000).toISOString();
    const today = new Date(now.setHours(0,0,0,0)).toISOString();

    // Toutes les requêtes en parallèle
    const [
      { count: totalEvents },
      { data: recentEvents },
      { data: sessions7d },
      { data: todaySessions },
      { data: consentEvents },
      { data: chatEvents },
      { data: pageviews },
      { data: pitchEvents },
      { data: daily30 }
    ] = await Promise.all([
      supabase.from('events').select('*', { count: 'exact', head: true }),
      supabase.from('events').select('*').order('created_at', { ascending: false }).limit(50),
      supabase.from('events').select('ip_hash, lang, is_mobile, created_at').gte('created_at', day7ago),
      supabase.from('events').select('ip_hash').gte('created_at', today),
      supabase.from('events').select('data, created_at, lang').eq('type', 'consent').order('created_at', { ascending: false }).limit(100),
      supabase.from('events').select('created_at').eq('type', 'chat'),
      supabase.from('events').select('data').eq('type', 'pageview'),
      supabase.from('events').select('created_at').eq('type', 'pitch'),
      supabase.from('events').select('created_at').gte('created_at', day30ago).order('created_at')
    ]);

    // Agréger sessions par jour (30j)
    const dailyMap = {};
    (daily30 || []).forEach(e => {
      const d = e.created_at.slice(0, 10);
      dailyMap[d] = (dailyMap[d] || 0) + 1;
    });

    // Agréger pages vues
    const pagesMap = {};
    (pageviews || []).forEach(e => {
      const page = e.data?.page || 'unknown';
      pagesMap[page] = (pagesMap[page] || 0) + 1;
    });

    // Langues
    const langMap = {};
    (sessions7d || []).forEach(s => {
      langMap[s.lang] = (langMap[s.lang] || 0) + 1;
    });

    // Mobile vs desktop
    const mobileCount = (sessions7d || []).filter(s => s.is_mobile).length;

    // Consentements
    const consentMap = { accept_all: 0, reject: 0, custom: 0 };
    let analyticsEnabled = 0, marketingEnabled = 0;
    (consentEvents || []).forEach(e => {
      const action = e.data?.action;
      if (consentMap[action] !== undefined) consentMap[action]++;
      if (e.data?.analytics) analyticsEnabled++;
      if (e.data?.marketing) marketingEnabled++;
    });

    // IPs uniques (sessions)
    const uniqueIPs7d = new Set((sessions7d || []).map(s => s.ip_hash)).size;
    const uniqueIPsToday = new Set((todaySessions || []).map(s => s.ip_hash)).size;

    // Heatmap horaire
    const hourMap = Array(24).fill(0);
    (recentEvents || []).forEach(e => {
      const h = new Date(e.created_at).getHours();
      hourMap[h]++;
    });

    return res.status(200).json({
      overview: {
        totalEvents,
        totalUsers: uniqueIPs7d + 41, // +41 seed initial
        sessions7d: sessions7d?.length || 0,
        uniqueToday: uniqueIPsToday,
        chatMessages: chatEvents?.length || 0,
        pitchGenerated: pitchEvents?.length || 0,
        mobilePct: sessions7d?.length ? Math.round(mobileCount / sessions7d.length * 100) : 0
      },
      consent: {
        ...consentMap,
        total: (consentEvents || []).length,
        analyticsEnabled,
        marketingEnabled
      },
      pages: pagesMap,
      langs: langMap,
      daily: dailyMap,
      hourly: hourMap,
      recentEvents: (recentEvents || []).slice(0, 30).map(e => ({
        type: e.type,
        data: e.data,
        lang: e.lang,
        is_mobile: e.is_mobile,
        created_at: e.created_at
      }))
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: err.message });
  }
}
