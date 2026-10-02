// Builds dist/, which Wrangler serves, from web/. Everything in web/ is copied as is, and the page's modules are
// also placed under dist/v/<hash of their contents>/, with the page importing from there. A page then always loads
// the modules it shipped with: right after a deploy, an edge can still hand out the old page for a few seconds, and
// that page finds its own versions, kept here for the last few deploys, instead of new modules it doesn't match.
// The unversioned /babel.js, /scan.js and /words.txt stay for agents and the docs.
// Run: node scripts/build.ts   (npm run dev and npm run deploy run it first)
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = new URL('../web/', import.meta.url).pathname, DIST = new URL('../dist/', import.meta.url).pathname;
const PAGE = 'short-stay-library.html', KEEP = 6;
const modules = readdirSync(WEB).filter(f => f.endsWith('.js') || f === 'words.txt').sort();

const hash = createHash('sha256');
for (const f of modules) hash.update(f).update(readFileSync(join(WEB, f)));
const v = hash.digest('hex').slice(0, 12);

mkdirSync(join(DIST, 'v', v), { recursive: true });
for (const f of readdirSync(WEB)) if (f !== PAGE) cpSync(join(WEB, f), join(DIST, f), { recursive: true });   // vendor/ is a folder
for (const f of modules) cpSync(join(WEB, f), join(DIST, 'v', v, f));

// the page imports its modules from this version's folder
let html = readFileSync(join(WEB, PAGE), 'utf8'), n = 0;
html = html.replace(/(from\s+')\.\/([a-z-]+\.js)'/g, (_, a, f) => { n++; return `${a}./v/${v}/${f}'`; });
if (!n) throw new Error(`${PAGE} imports no ./module.js: nothing to version`);
writeFileSync(join(DIST, PAGE), html);

// versioned files never change, so they can be cached for good, and vendor/ (three.js, named by its version, and the
// fonts) doesn't either. The page gets a Content-Security-Policy: everything from here and nowhere else; scripts only
// from files here and the page's one inline module, allowed by its hash, worked out here from the page as built (its
// import paths were just rewritten); no framing, no plugins.
const inline = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
if (!inline) throw new Error(`${PAGE} has no inline module script to hash`);
const scriptHash = createHash('sha256').update(inline[1]).digest('base64');
const csp = [`default-src 'self'`, `script-src 'self' 'sha256-${scriptHash}'`,
  `style-src 'self' 'unsafe-inline'`, `font-src 'self'`, `img-src 'self' data: blob:`,
  `connect-src 'self'`, `worker-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`].join('; ');
const pageHeaders = `  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n`;
writeFileSync(join(DIST, '_headers'), '/v/*\n  Cache-Control: public, max-age=31536000, immutable\n/vendor/*\n  Cache-Control: public, max-age=31536000, immutable\n'
  + `/short-stay-library\n${pageHeaders}/short-stay-library.html\n${pageHeaders}`);

// keep this version and the newest KEEP - 1 others
const versions = readdirSync(join(DIST, 'v')).filter(d => d !== v).map(d => ({ d, t: statSync(join(DIST, 'v', d)).mtimeMs })).sort((a, b) => b.t - a.t);
for (const { d } of versions.slice(KEEP - 1)) rmSync(join(DIST, 'v', d), { recursive: true });
console.log(`dist/: version ${v} (${n} imports in the page), ${1 + Math.min(versions.length, KEEP - 1)} versions kept`);
if (!existsSync(join(DIST, 'v', v, 'babel.js'))) throw new Error('build is missing babel.js');
