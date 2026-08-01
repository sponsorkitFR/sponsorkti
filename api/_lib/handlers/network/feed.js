// api/network/feed.js
// Feed social : posts, likes, commentaires, suggestions d'utilisateurs

import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Non autorisé' });

  try {
    // ── GET : récupérer le feed ───────────────────────────────────────
    if (req.method === 'GET') {
      const { type, cursor, limit = 20 } = req.query;

      // Feed personnalisé = posts des gens qu'on suit + les siens
      const { data: following } = await sb
        .from('follows')
        .select('following_id')
        .eq('follower_id', user.id);

      const followingIds = [user.id, ...(following || []).map(f => f.following_id)];

      let query = sb.from('posts')
        .select(`
          *,
          profiles(id, first_name, channel_name, platform, niche, subscribers, engagement_rate),
          brands(id, brand_name, sector),
          post_reactions(user_id, type),
          post_comments(id, content, author_id, created_at,
            profiles:author_id(first_name, channel_name),
            brands:author_id(brand_name)
          )
        `)
        .order('created_at', { ascending: false })
        .limit(parseInt(limit));

      if (type === 'following') {
        query = query.in('author_id', followingIds);
      } else if (type === 'discover') {
        // Feed découverte : posts publics pas encore vus, pas déjà suivis
        query = query.eq('is_public', true).not('author_id', 'in', `(${followingIds.join(',')})`);
      } else {
        // Feed mixte : gens suivis + discover
        query = query.eq('is_public', true);
      }

      if (cursor) query = query.lt('created_at', cursor);

      const { data: posts, error } = await query;
      if (error) throw error;

      // Enrichir chaque post avec infos auteur + si l'user a liké
      const enriched = (posts || []).map(p => ({
        ...p,
        author: p.author_type === 'creator' ? p.profiles : p.brands,
        has_liked: (p.post_reactions || []).some(r => r.user_id === user.id),
        my_reaction: (p.post_reactions || []).find(r => r.user_id === user.id)?.type || null,
        comments: (p.post_comments || []).slice(0, 3),
        next_cursor: posts.length === parseInt(limit) ? posts[posts.length - 1]?.created_at : null
      }));

      return res.status(200).json({ posts: enriched });
    }

    // ── POST : créer un post ──────────────────────────────────────────
    if (req.method === 'POST') {
      const { content, post_type = 'update', tags = [], media_url, media_type } = req.body;
      if (!content?.trim()) return res.status(400).json({ error: 'Contenu requis' });
      if (content.length > 1000) return res.status(400).json({ error: 'Maximum 1000 caractères' });

      // Déterminer si c'est un créateur ou une marque
      const { data: profile } = await sb.from('profiles').select('id').eq('id', user.id).single();
      const author_type = profile ? 'creator' : 'brand';

      const { data, error } = await sb.from('posts').insert({
        author_id: user.id,
        author_type,
        content: content.trim(),
        post_type,
        tags,
        media_url: media_url || null,
        media_type: media_type || null,
        is_public: true,
        created_at: new Date().toISOString()
      }).select().single();

      if (error) throw error;

      // Notifier les followers
      const { data: followers } = await sb.from('follows')
        .select('follower_id')
        .eq('following_id', user.id);

      if (followers?.length) {
        const notifs = followers.map(f => ({
          user_id: f.follower_id,
          type: 'new_post',
          title: 'Nouvelle publication',
          message: content.slice(0, 80) + (content.length > 80 ? '...' : ''),
          read: false,
          created_at: new Date().toISOString()
        }));
        await sb.from('notifications').insert(notifs);
      }

      return res.status(201).json({ post: data });
    }

    // ── PUT : liker / commenter ───────────────────────────────────────
    if (req.method === 'PUT') {
      const { action, post_id, reaction_type, comment } = req.body;

      if (action === 'react') {
        // Vérifier si déjà réagi
        const { data: existing } = await sb.from('post_reactions')
          .select('id, type').eq('post_id', post_id).eq('user_id', user.id).single();

        if (existing) {
          if (existing.type === reaction_type) {
            // Retirer la réaction
            await sb.from('post_reactions').delete().eq('post_id', post_id).eq('user_id', user.id);
            return res.status(200).json({ action: 'removed' });
          } else {
            // Changer le type
            await sb.from('post_reactions').update({ type: reaction_type })
              .eq('post_id', post_id).eq('user_id', user.id);
            return res.status(200).json({ action: 'changed', type: reaction_type });
          }
        } else {
          await sb.from('post_reactions').insert({ post_id, user_id: user.id, type: reaction_type || 'like' });
          // Notifier l'auteur
          const { data: post } = await sb.from('posts').select('author_id').eq('id', post_id).single();
          if (post && post.author_id !== user.id) {
            await sb.from('notifications').insert({
              user_id: post.author_id, type: 'reaction',
              title: 'Quelqu\'un a réagi à ton post', message: 'Nouvelle réaction sur ta publication.',
              read: false, created_at: new Date().toISOString()
            });
          }
          return res.status(200).json({ action: 'added', type: reaction_type || 'like' });
        }
      }

      if (action === 'comment') {
        if (!comment?.trim()) return res.status(400).json({ error: 'Commentaire vide' });
        const { data } = await sb.from('post_comments').insert({
          post_id, author_id: user.id, content: comment.trim(),
          created_at: new Date().toISOString()
        }).select().single();

        // Notifier l'auteur
        const { data: post } = await sb.from('posts').select('author_id').eq('id', post_id).single();
        if (post && post.author_id !== user.id) {
          await sb.from('notifications').insert({
            user_id: post.author_id, type: 'comment',
            title: 'Nouveau commentaire', message: comment.slice(0, 80),
            read: false, created_at: new Date().toISOString()
          });
        }
        return res.status(201).json({ comment: data });
      }

      return res.status(400).json({ error: 'Action non reconnue' });
    }

    // ── DELETE : supprimer son post ───────────────────────────────────
    if (req.method === 'DELETE') {
      const { id } = req.query;
      const { data: post } = await sb.from('posts').select('author_id').eq('id', id).single();
      if (!post || post.author_id !== user.id) return res.status(403).json({ error: 'Accès refusé' });
      await sb.from('posts').delete().eq('id', id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    console.error('Feed error:', err);
    return res.status(500).json({ error: err.message });
  }
}
