export default function handler(req, res) {
  res.status(200).json({
    SUPABASE_URL_present: !!process.env.SUPABASE_URL,
    SUPABASE_URL_value: process.env.SUPABASE_URL || 'MANQUANT',
    SERVICE_KEY_present: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    SERVICE_KEY_length: process.env.SUPABASE_SERVICE_ROLE_KEY ? process.env.SUPABASE_SERVICE_ROLE_KEY.length : 0,
    GEMINI_present: !!process.env.GEMINI_API_KEY,
  });
}
