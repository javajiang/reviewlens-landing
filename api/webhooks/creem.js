const crypto = require('crypto');

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    const secret = process.env.CREEM_WEBHOOK_SECRET;
    if (!secret) {
      res.status(500).json({ ok: false, error: 'CREEM_WEBHOOK_SECRET is not set' });
      return;
    }

    const rawBody = await readRawBody(req);
    const signature = String(req.headers['creem-signature'] || req.headers['x-creem-signature'] || '');

    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!signature || !timingSafeEqual(signature, expected)) {
      res.status(400).json({ ok: false, error: 'Invalid webhook signature' });
      return;
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      res.status(400).json({ ok: false, error: 'Invalid JSON payload' });
      return;
    }

    console.log('Creem webhook event:', event);

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};
