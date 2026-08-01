// api/brand/reporting.js — Statistiques ROI campagnes
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = req.headers.authorization?.replace('Bearer ','');
  const { data:{ user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error:'Non autorisé' });
  try {
    const { data: campaigns } = await sb.from('campaigns')
      .select('*, deliverables(views_count,engagement_rate), brand_payments(amount,status)')
      .eq('brand_id', user.id);
    const enriched = (campaigns||[]).map(c => {
      const views = (c.deliverables||[]).reduce((s,d)=>s+(d.views_count||0),0);
      const engagement = c.deliverables?.length ? (c.deliverables.reduce((s,d)=>s+(d.engagement_rate||0),0)/c.deliverables.length) : 0;
      const spent = (c.brand_payments||[]).filter(p=>p.status==='completed').reduce((s,p)=>s+p.amount,0);
      const roi = spent > 0 && views > 0 ? views / spent : null;
      return { ...c, views, engagement, spent, roi };
    });
    const totalViews = enriched.reduce((s,c)=>s+c.views,0);
    const avgEngage = enriched.length ? enriched.reduce((s,c)=>s+c.engagement,0)/enriched.length : 0;
    const totalSpent = enriched.reduce((s,c)=>s+c.spent,0);
    const cpv = totalSpent > 0 && totalViews > 0 ? totalSpent/totalViews : null;
    const best = enriched.sort((a,b)=>(b.roi||0)-(a.roi||0))[0];
    return res.status(200).json({
      campaigns: enriched,
      stats: { total_views: totalViews, avg_engagement: avgEngage, cpv, best_campaign: best?.title || null }
    });
  } catch(err) { return res.status(500).json({ error: err.message }); }
}
