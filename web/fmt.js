// fmt.js (v2.27) — one number format for the whole board: K / M / G with at most three
// significant digits (985M, 66.2M, 12.8K, 1.02G, 137). Trailing zeros are dropped (5.9, not
// 5.90): the point is the narrowest string that is still exact to three digits.
// server/usage.js and server/token_detail.js keep a byte-for-byte copy (the server cannot
// import from web/).
export function sig3(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const x = Number(n);
  if (x === 0) return '0';
  const a = Math.abs(x);
  const s = a >= 100 ? String(Math.round(a)) : String(Number(a.toPrecision(3)));
  return (x < 0 ? '-' : '') + s;
}

export function si3(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const x = Number(n), a = Math.abs(x), sg = x < 0 ? '-' : '';
  if (a < 999.5) return sg + String(Math.round(a));
  const units = [['G', 1e9], ['M', 1e6], ['K', 1e3]];
  for (let i = 0; i < units.length; i++) {
    const [u, d] = units[i];
    if (a >= d * 0.9995) {   // (999.6 is "1K", not "1000")
      let v = Number((a / d).toPrecision(3));
      // 999.6K rounds to 1000K: say 1M instead
      if (v >= 1000 && i > 0) { const [u2, d2] = units[i - 1]; return sg + String(Number((a / d2).toPrecision(3))) + u2; }
      return sg + String(v) + u;
    }
  }
  return sg + String(Math.round(a));
}
