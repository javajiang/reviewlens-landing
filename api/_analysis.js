function normalizeReviewText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reviewRating(review) {
  const value = Number(
    review?.rating ??
    review?.stars ??
    review?.score ??
    review?.reviewRating
  );
  return Number.isFinite(value) ? value : 3;
}

function prepareReviewsForAnalysis(reviews, limit = 100) {
  const seen = new Set();
  const cleaned = [];

  for (const review of Array.isArray(reviews) ? reviews : []) {
    const body = normalizeReviewText(review?.body || review?.text || review?.content);
    const title = normalizeReviewText(review?.title || review?.headline);
    const key = `${title}\n${body}`.toLowerCase();
    if (!body || seen.has(key)) continue;
    seen.add(key);
    cleaned.push({
      ...review,
      title: title || null,
      body,
      rating: reviewRating(review),
    });
  }

  cleaned.sort((left, right) => left.rating - right.rating);
  return cleaned.slice(0, limit);
}

function buildReviewStats(reviews) {
  const stats = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const rating = reviewRating(review);
    const bucket = Math.min(5, Math.max(1, Math.round(rating)));
    stats[bucket] += 1;
  }
  return stats;
}

module.exports = {
  buildReviewStats,
  normalizeReviewText,
  prepareReviewsForAnalysis,
  reviewRating,
};
