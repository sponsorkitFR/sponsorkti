// api/network/search.js
// Recherche avancée de créateurs et marques + suggestions + follow/unfollow

import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Non autorisé' });

  try {
    // ── GET : recherche / suggestions ─────────────────────────────────
    if (req.method === 'GET') {
      const { q, type, niche, platform, min_subs, max_rate, action } = req.query;

      // Qui je suis déjà
      const { data: alreadyFollowing } = await sb.from('follows')
        .select('following_id').eq('follower_id', user.id);
      const followingIds = new Set((alreadyFollowing || []).map(f => f.following_id));
      followingIds.add(user.id); // s'exclure soi-même

      // ── Suggestions intelligentes ─────────────────────────────────
      if (action === 'suggestions') {
        // Mon profil pour matcher
        const { data: myProfile } = await sb.from('profiles').select('*').eq('id', user.id).single();
        const { data: myBrand } = await sb.from('brands').select('*').eq('id', user.id).single();

        let suggestions = [];

        // Créateurs similaires (même niche)
        if (myProfile?.niche) {
          const { data: similarCreators } = await sb.from('profiles')
            .select('id, first_name, channel_name, platform, niche, subscribers, engagement_rate, avg_views, base_rate, public_profile, verified_provider')
            .eq('public_profile', true)
            .eq('niche', myProfile.niche)
            .not('id', 'in', `(${[...followingIds].join(',')})`)
            .order('subscribers', { ascending: false })
            .limit(6);
          suggestions.push(...(similarCreators || []).map(c => ({ ...c, account_type: 'creator', reason: `Créateur ${c.niche} comme toi` })));
        }

        // Créateurs complémentaires (niches différentes, même plateforme)
        if (myProfile?.platform) {
          const { data: complementary } = await sb.from('profiles')
            .select('id, first_name, channel_name, platform, niche, subscribers, engagement_rate, avg_views, base_rate, verified_provider')
            .eq('public_profile', true)
            .eq('platform', myProfile.platform)
            .not('niche', 'eq', myProfile.niche || '')
            .not('id', 'in', `(${[...followingIds].join(',')})`)
            .order('engagement_rate', { ascending: false })
            .limit(4);
          suggestions.push(...(complementary || []).map(c => ({ ...c, account_type: 'creator', reason: `${c.platform} · Niche complémentaire` })));
        }

        // Marques dans le secteur
        const { data: activeBrands } = await sb.from('brands')
          .select('id, brand_name, sector, monthly_budget, website')
          .not('id', 'in', `(${[...followingIds].join(',')})`)
          .order('monthly_budget', { ascending: false })
          .limit(4);
        suggestions.push(...(activeBrands || []).map(b => ({ ...b, account_type: 'brand', reason: `Marque ${b.sector}` })));

        // Enrichir avec stats follow
        const enriched = await Promise.all(suggestions.slice(0, 12).map(async s => {
          const { count: followersCount } = await sb.from('follows')
            .select('*', { count: 'exact', head: true }).eq('following_id', s.id);
          const isFollowing = followingIds.has(s.id);
          return { ...s, followers_count: followersCount || 0, is_following: isFollowing };
        }));

        return res.status(200).json({ suggestions: enriched });
      }

      // ── Recherche textuelle ───────────────────────────────────────
      if (q) {
        const searchTerm = q.trim().toLowerCase();
        let creators = [], brands = [];

        // Recherche créateurs
        if (!type || type === 'creator') {
          let cQuery = sb.from('profiles')
            .select('id, first_name, last_name, channel_name, platform, niche, subscribers, engagement_rate, avg_views, base_rate, public_profile, verified_provider')
            .eq('public_profile', true);

          if (searchTerm) {
            cQuery = cQuery.or(`channel_name.ilike.%${searchTerm}%,first_name.ilike.%${searchTerm}%,niche.ilike.%${searchTerm}%`);
          }
          if (niche) cQuery = cQuery.ilike('niche', `%${niche}%`);
          if (platform) cQuery = cQuery.eq('platform', platform);
          if (min_subs) cQuery = cQuery.gte('subscribers', parseInt(min_subs));
          if (max_rate) cQuery = cQuery.lte('base_rate', parseInt(max_rate));

          const { data } = await cQuery.order('subscribers', { ascending: false }).limit(20);
          creators = (data || []).map(c => ({ ...c, account_type: 'creator' }));
        }

        // Recherche marques
        if (!type || type === 'brand') {
          const { data } = await sb.from('brands')
            .select('id, brand_name, sector, monthly_budget, website, description')
            .or(`brand_name.ilike.%${searchTerm}%,sector.ilike.%${searchTerm}%,description.ilike.%${searchTerm}%`)
            .limit(10);
          brands = (data || []).map(b => ({ ...b, account_type: 'brand' }));
        }

        const all = [...creators, ...brands];
        const withFollowStatus = all.map(u => ({
          ...u,
          is_following: followingIds.has(u.id)
        }));

        return res.status(200).json({ results: withFollowStatus, creators_count: creators.length, brands_count: brands.length });
      }

      // ── Liste mes followers / following ───────────────────────────
      if (action === 'followers') {
        const targetId = req.query.user_id || user.id;
        const { data } = await sb.from('follows')
          .select('follower_id, created_at')
          .eq('following_id', targetId)
          .order('created_at', { ascending: false });
        return res.status(200).json({ followers: data || [] });
      }

      if (action === 'following') {
        const targetId = req.query.user_id || user.id;
        const { data } = await sb.from('follows')
          .select('following_id, created_at')
          .eq('follower_id', targetId)
          .order('created_at', { ascending: false });
        return res.status(200).json({ following: data || [] });
      }

      return res.status(400).json({ error: 'Paramètre requis : q ou action' });
    }

    // ── POST : follow ─────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { target_id } = req.body;
      if (!target_id) return res.status(400).json({ error: 'target_id requis' });
      if (target_id === user.id) return res.status(400).json({ error: 'Impossible de se suivre soi-même' });

      // Vérifier si déjà suivi
      const { data: existing } = await sb.from('follows')
        .select('id').eq('follower_id', user.id).eq('following_id', target_id).single();

      if (existing) return res.status(200).json({ already_following: true });

      await sb.from('follows').insert({
        follower_id: user.id,
        following_id: target_id,
        created_at: new Date().toISOString()
      });

      // Notifier la personne suivie
      const { data: myProfile } = await sb.from('profiles').select('channel_name, first_name').eq('id', user.id).single();
      const { data: myBrand } = await sb.from('brands').select('brand_name').eq('id', user.id).single();
      const myName = myProfile?.channel_name || myProfile?.first_name || myBrand?.brand_name || 'Quelqu\'un';

      await sb.from('notifications').insert({
        user_id: target_id, type: 'new_follower',
        title: 'Nouveau follower',
        message: `${myName} a commencé à te suivre.`,
        read: false, created_at: new Date().toISOString()
      });

      return res.status(201).json({ followed: true });
    }

    // ── DELETE : unfollow ─────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { target_id } = req.query;
      await sb.from('follows')
        .delete()
        .eq('follower_id', user.id)
        .eq('following_id', target_id);
      return res.status(200).json({ unfollowed: true });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    console.error('Search/follow error:', err);
    return res.status(500).json({ error: err.message });
  }
}
