import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
export function publicV4(address) {
  const p = address.split('.').map(Number);
  return p.length === 4 && p.every(x => Number.isInteger(x) && x >= 0 && x <= 255)
    && ![0,10,127].includes(p[0]) && p[0] < 224
    && !(p[0] === 169 && p[1] === 254) && !(p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    && !(p[0] === 192 && (p[1] === 168 || p[1] === 0)) && !(p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    && !(p[0] === 198 && [18,19].includes(p[1]));
}
// Pin a checked public address into the HTTPS request to prevent DNS rebinding.
export async function readPublicPage(value, host, redirects = 0) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || redirects > 3
    || !(url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('Untrusted website destination');
  const result = await lookup(url.hostname, { family: 4, all: true });
  if (!result.length || result.some(x => !publicV4(x.address))) throw new Error('Non-public website address');
  return new Promise((resolve, reject) => {
    const req = request(url, { lookup: (_hostname, options, callback) => callback(null, options.all ? [{ address: result[0].address, family: 4 }] : result[0].address, 4) }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        res.resume(); readPublicPage(new URL(res.headers.location, url).href, host, redirects + 1).then(resolve,reject); return;
      }
      if (res.statusCode !== 200) { res.resume(); resolve(''); return; }
      let size = 0, text = ''; res.setEncoding('utf8');
      res.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 1000000) req.destroy(new Error('Website too large')); else text += chunk; });
      res.on('end', () => resolve(text)); res.on('error', reject);
    });
    req.setTimeout(12000, () => req.destroy(new Error('Website timeout'))); req.on('error', reject); req.end();
  });
}
