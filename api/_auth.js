function getBearerToken(req) {
  const header = String(req.headers?.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function getSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    ''
  ).trim();

  if (!url || !key) {
    throw new Error('Supabase auth is not configured');
  }

  return { url, key };
}

async function getUserFromRequest(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  const { url, key } = getSupabaseConfig();
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) return null;

  const user = await response.json();
  if (!user?.id) return null;

  return {
    id: String(user.id),
    email: user.email ? String(user.email) : null,
    token,
  };
}

module.exports = {
  getBearerToken,
  getSupabaseConfig,
  getUserFromRequest,
};
