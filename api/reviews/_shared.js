const { getPool } = require('../_db');
const { ensureShopifySchema, normalizeShopDomain } = require('../_shopify');

const MAX_REVIEWS = 5000;

function isValidShop(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

function normalizeHandle(handle) {
  return String(handle || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('?')[0]
    .split('#')[0];
}

function handleFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const match = url.pathname.match(/\/products\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function normalizeReview(review) {
  const raw = review && typeof review === 'object' ? review : {};
  return {
    reviewId: clean(raw.reviewId || raw.id || raw.providerReviewId || ''),
    source: clean(raw.source || 'review'),
    rating: normalizeRating(raw.rating),
    title: clean(raw.title || ''),
    body: clean(raw.body || raw.content || raw.text || ''),
    author: clean(raw.author || raw.name || 'Anonymous'),
    date: clean(raw.date || raw.createdAt || raw.created_at || ''),
    helpfulCount: normalizeInteger(raw.helpfulCount || raw.helpful_count),
    verified: Boolean(raw.verified),
  };
}

function normalizeReviews(reviews) {
  if (!Array.isArray(reviews)) return [];
  return reviews
    .slice(0, MAX_REVIEWS)
    .map(normalizeReview)
    .filter((review) => review.body || review.title);
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeRating(value) {
  const rating = Number(value);
  if (!Number.isFinite(rating)) return null;
  return Math.max(0, Math.min(5, rating));
}

function normalizeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.trunc(number));
}

async function getAuthorizedInstallation(client, shop) {
  const result = await client.query(
    `
      SELECT shop_domain, scope
      FROM shopify_installations
      WHERE shop_domain = $1
      LIMIT 1
    `,
    [shop]
  );
  return result.rows[0] || null;
}

module.exports = {
  MAX_REVIEWS,
  getPool,
  ensureShopifySchema,
  normalizeShopDomain,
  isValidShop,
  normalizeHandle,
  handleFromUrl,
  normalizeReviews,
  getAuthorizedInstallation,
};
