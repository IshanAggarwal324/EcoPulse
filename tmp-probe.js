const base = 'https://ecopulse-83lb.onrender.com/api/v1';
async function hit(method, path, timeoutMs = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, signal: c.signal });
    const ms = Date.now() - start;
    const txt = await res.text();
    let j; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0,200) }; }
    return { ms, status: res.status, j };
  } catch (e) {
    return { ms: Date.now() - start, status: 'ERR', j: { err: e.name === 'AbortError' ? 'TIMEOUT' : e.message } };
  } finally { clearTimeout(t); }
}
(async () => {
  const status = await hit('GET', '/analytics/status');
  console.log('=== /analytics/status (' + status.ms + 'ms, ' + status.status + ') ===');
  console.log(JSON.stringify(status.j?.data?.blockchain || status.j, null, 2));

  const hist = await hit('GET', '/trades/history?limit=100');
  console.log('\n=== /trades/history total indexed: ' + (hist.j?.data?.pagination?.total) + ' (' + hist.ms + 'ms) ===');
  const trades = hist.j?.data?.trades || [];
  console.log('trades returned: ' + trades.length);
  trades.forEach(t => console.log(`  listing#${t.listingId} ${t.eventType} block=${t.blockNumber} chain=${t.chainId} contract=${t.contractAddress}`));
})();
