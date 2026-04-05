// Vercel serverless function — proxy para api.hyperliquid.xyz
// Resolve o problema de CORS quando a página está hospedada no Vercel

module.exports = async function handler(req, res) {
  // CORS headers — devem vir antes de qualquer resposta
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight OPTIONS (navegadores enviam antes do POST)
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Só aceita POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });

    // Repassa o corpo como JSON (sempre 200 para o cliente)
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(502).json({ error: 'Upstream error', detail: err.message });
  }
};
