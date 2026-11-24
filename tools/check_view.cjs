// Checks the drawing in a real browser: draws the lab page's view with WebGL and with the 2D
// fallback from 60 directions of view (all round, looking down to almost straight up, 20 to 170
// degrees wide) and compares them pixel by pixel. They must agree; a piece of ground stretched
// across the sky shows up here at once. Also saves a picture of each preset to look at.
//
//   npm install --no-save playwright && npx playwright install chromium   (once)
//   node tools/check_view.cjs [folder for the pictures]
//
// Not part of npm test: it needs a browser. Run it after changing view.js.
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const out = process.argv[2] || '.';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split(/[?#]/)[0]));
  try {
    const body = await readFile(file);
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 404; res.end(); }
}).listen(0);

(async () => {
  const url = `http://localhost:${server.address().port}/lab.html`;
  // SwiftShader: WebGL without a graphics card, so this runs anywhere. Slow, so no timings here.
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 500, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shoot = async (hash, file) => {
    await page.goto('about:blank');
    await page.goto(`${url}#${hash}`);
    await page.waitForFunction(() => document.getElementById('readout').textContent.includes('Scene'), null, { timeout: 60000 });
    await page.waitForTimeout(150);
    await page.evaluate(() => { document.getElementById('overlay').style.display = 'none'; });
    return page.locator('#stage').screenshot(file ? { path: file } : {});
  };
  const differs = (a, b) => page.evaluate(async ([a, b]) => {
    const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = `data:image/png;base64,${s}`; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const g = new OffscreenCanvas(ia.width, ia.height).getContext('2d');
    g.drawImage(ia, 0, 0); const A = g.getImageData(0, 0, ia.width, ia.height).data;
    g.drawImage(ib, 0, 0); const B = g.getImageData(0, 0, ia.width, ia.height).data;
    let n = 0;
    for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 60) n++;
    return n / (A.length / 4);
  }, [a.toString('base64'), b.toString('base64')]);

  let worst = 0;
  const failed = [];
  for (const yaw of [25, 115, 205, 300]) for (const pitch of [-30, 0, 4, 40, 85]) for (const fov of [20, 110, 170]) {
    const hash = `preset=quick&palette="light"&yaw=${yaw}&pitch=${pitch}&fov=${fov}`;
    const share = await differs(await shoot(hash), await shoot(`${hash}&renderer=canvas`));
    worst = Math.max(worst, share);
    if (share > 0.01) failed.push(`yaw ${yaw}, pitch ${pitch}, ${fov} wide: ${(share * 100).toFixed(1)}% of pixels differ`);
  }
  for (const preset of ['quick', 'standard', 'detailed']) await shoot(`preset=${preset}&palette="light"&pitch=6`, path.join(out, `view-${preset}.png`));
  await browser.close();
  server.close();
  console.log(`60 directions of view: WebGL and 2D differ in at most ${(worst * 100).toFixed(2)}% of pixels`);
  if (errors.length) console.log(`Page errors:\n${errors.join('\n')}`);
  if (failed.length) console.log(`Disagree:\n${failed.join('\n')}`);
  console.log(`Pictures of the presets in ${path.resolve(out)}`);
  process.exit(failed.length || errors.length ? 1 : 0);
})();
