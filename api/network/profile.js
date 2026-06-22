// api/network/profile.js
// Profil public partageable — créateurs ET marques
// URL : /api/network/profile?id=UUID ou /api/network/profile?slug=alex-martin

import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── GET profil public (pas besoin d'auth) ─────────────────────────
    if (req.method === 'GET') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id requis' });

      // Chercher dans profils créateurs
      const { data: creator } = await sb.from('profiles')
        .select('*')
        .eq('id', id)
        .eq('public_profile', true)
        .single();

      // Chercher dans marques
      const { data: brand } = creator ? { data: null } : await sb.from('brands')
        .select('*')
        .eq('id', id)
        .single();

      const profile = creator || brand;
      if (!profile) return res.status(404).json({ error: 'Profil non trouvé' });

      const account_type = creator ? 'creator' : 'brand';

      // Stats réseau
      const { count: followersCount } = await sb.from('follows')
        .select('*', { count: 'exact', head: true }).eq('following_id', id);
      const { count: followingCount } = await sb.from('follows')
        .select('*', { count: 'exact', head: true }).eq('follower_id', id);

      // Posts publics récents
      const { data: recentPosts } = await sb.from('posts')
        .select('id, content, post_type, likes_count, comments_count, created_at, tags')
        .eq('author_id', id)
        .eq('is_public', true)
        .order('created_at', { ascending: false })
        .limit(6);

      // Deals anonymisés (si créateur)
      let anonymizedDeals = [];
      if (account_type === 'creator') {
        const { data: deals } = await sb.from('deals')
          .select('format, amount, status, created_at')
          .eq('user_id', id)
          .in('status', ['paid', 'signed', 'completed'])
          .order('created_at', { ascending: false })
          .limit(5);
        // Anonymiser : on montre le format et le montant mais PAS la marque
        anonymizedDeals = (deals || []).map(d => ({
          format: d.format,
          amount: d.amount ? Math.round(d.amount / 100) * 100 : null, // arrondi
          status: d.status,
          date: d.created_at?.slice(0, 7) // mois/année seulement
        }));
      }

      // Campagnes actives (si marque)
      let activeCampaigns = [];
      if (account_type === 'brand') {
        const { data: campaigns } = await sb.from('campaigns')
          .select('title, format, total_budget, target_niches, status')
          .eq('brand_id', id)
          .eq('status', 'active')
          .limit(3);
        activeCampaigns = campaigns || [];
      }

      // Statut follow (si authentifié)
      let is_following = false;
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        const { data: { user } } = await sb.auth.getUser(token);
        if (user && user.id !== id) {
          const { data: follow } = await sb.from('follows')
            .select('id').eq('follower_id', user.id).eq('following_id', id).single();
          is_following = !!follow;
        }
      }

      return res.status(200).json({
        profile: {
          ...profile,
          account_type,
          followers_count: followersCount || 0,
          following_count: followingCount || 0,
          is_following,
          recent_posts: recentPosts || [],
          deals: anonymizedDeals,
          active_campaigns: activeCampaigns
        }
      });
    }

    // ── PUT : mettre à jour son propre profil public ──────────────────
    if (req.method === 'PUT') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'Auth requise' });
      const { data: { user }, error: authErr } = await sb.auth.getUser(token);
      if (authErr || !user) return res.status(401).json({ error: 'Token invalide' });

      const { bio, social_links, availability, public_profile, portfolio_urls } = req.body;

      // Détecter si créateur ou marque
      const { data: isCreator } = await sb.from('profiles').select('id').eq('id', user.id).single();

      if (isCreator) {
        const updates = {};
        if (bio !== undefined) updates.bio = bio;
        if (availability !== undefined) updates.availability = availability;
        if (public_profile !== undefined) updates.public_profile = public_profile;
        if (social_links !== undefined) updates.social_links = social_links;
        if (portfolio_urls !== undefined) updates.portfolio_urls = portfolio_urls;
        updates.updated_at = new Date().toISOString();

        const { data } = await sb.from('profiles').update(updates).eq('id', user.id).select().single();
        return res.status(200).json({ profile: data });
      } else {
        const updates = {};
        if (bio !== undefined) updates.description = bio;
        if (social_links !== undefined) updates.social_links = social_links;
        updates.updated_at = new Date().toISOString();
        const { data } = await sb.from('brands').update(updates).eq('id', user.id).select().single();
        return res.status(200).json({ profile: data });
      }
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    console.error('Profile error:', err);
    return res.status(500).json({ error: err.message });
  }
}
