// Dokunma ölçümü (yalnızca test dalı): gerçek Android + ws-scrcpy-web + kapı üzerinden,
// iPhone gibi davranan (force=0) dokunmaların Android'e ulaşıp ulaşmadığını ölçer.
// Kullanım: ADB=<adb> TARAYICI=chrome|webkit node dokunma-olcum.js <sayfa: tam.html|tam-eski.html> <etiket>
const fs = require('fs');
const { execFileSync } = require('child_process');
const pw = require(process.env.PW_YOL || 'playwright-core');

const ADB = process.env.ADB;
const SIR = fs.readFileSync('/tmp/oturum/sir', 'utf8').trim();
const SAYFA = process.argv[2];
const ETIKET = process.argv[3] || SAYFA;
const TARAYICI = process.env.TARAYICI || 'chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sonuc = [];
const not = (baslik, metin) => { console.log(`::notice title=${ETIKET} · ${baslik}::${metin}`); sonuc.push(baslik + ': ' + metin); };

function adb(...a) { return execFileSync(ADB, ['-s', 'emulator-5554', ...a], { encoding: 'utf8', timeout: 30000 }); }
function odak() {
  const s = adb('shell', 'dumpsys', 'activity', 'activities');
  const m = /(topResumedActivity|mResumedActivity)[^\n]*/.exec(s);
  return m ? m[0].trim().replace(/\s+/g, ' ') : '';
}
function pencere() {
  const m = /mCurrentFocus=[^\n]*/.exec(adb('shell', 'dumpsys', 'window', 'windows'));
  return m ? m[0].trim() : '';
}
function ayarlariAc() {
  adb('shell', 'am', 'force-stop', 'com.android.settings');
  adb('shell', 'cmd', 'statusbar', 'collapse');
  adb('shell', 'am', 'start', '-W', '-a', 'android.settings.SETTINGS');
}
function arayuz() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/u.xml');
  const x = adb('shell', 'cat', '/sdcard/u.xml');
  const dugumler = [];
  const re = /<node [^>]*?text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m;
  while ((m = re.exec(x))) dugumler.push({ metin: m[1], x0: +m[2], y0: +m[3], x1: +m[4], y1: +m[5] });
  return dugumler;
}
function hedef() {
  const d = arayuz();
  const h = d.find((n) => /Network|internet/i.test(n.metin)) || d.find((n) => n.metin && n.y0 > 200);
  return h ? { metin: h.metin, x: Math.round((h.x0 + h.x1) / 2), y: Math.round((h.y0 + h.y1) / 2) } : null;
}
function ekranBoyu() {
  const m = /(Override|Physical) size: (\d+)x(\d+)/.exec(adb('shell', 'wm', 'size').split('\n').reverse().join('\n'));
  return m ? { en: +m[2], boy: +m[3] } : null;
}

(async () => {
  const url = `http://127.0.0.1:8080/k/${SIR}/${SAYFA}?device=emulator-5554&host=127.0.0.1&port=8080&secure=false` +
    `&pathname=${encodeURIComponent('/k/' + SIR + '/')}&codec=h264&deviceKind=phone&audio=false&maxFps=30&bitrate=4000000`;
  const iphone = {
    viewport: { width: 430, height: 839 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  };
  const tarayici = TARAYICI === 'webkit'
    ? await pw.webkit.launch()
    : await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const baglam = await tarayici.newContext(TARAYICI === 'webkit' ? pw.devices['iPhone 15 Plus'] : iphone);
  const sayfa = await baglam.newPage();
  const hatalar = [];
  sayfa.on('pageerror', (e) => hatalar.push(String(e).slice(0, 160)));
  const giden = [];
  sayfa.on('websocket', (ws) => {
    if (!ws.url().includes('action=stream')) return;
    not('akış soketi', ws.url().replace(SIR, '<sır>').replace(/^.*\?/, '?'));
    ws.on('framesent', (f) => {
      const b = Buffer.isBuffer(f.payload) ? f.payload : Buffer.from(f.payload || '');
      if (b.length === 33 && b[0] === 2 && b[1] === 2) {
        giden.push({ eylem: b[2], id: b.readUInt32BE(7), x: b.readUInt32BE(11), y: b.readUInt32BE(15), en: b.readUInt16BE(19), boy: b.readUInt16BE(21), basinc: b.readUInt16BE(23) });
      }
    });
  });

  ayarlariAc();
  await sayfa.goto(url);
  // Akış bağlansın, ilk kareler gelsin
  let tuval = null;
  for (let i = 0; i < 60 && !tuval; i++) {
    await sleep(500);
    tuval = await sayfa.evaluate(() => {
      const c = document.querySelector('.touch-layer');
      if (!c || !c.width) return null;
      const r = c.getBoundingClientRect();
      return { en: c.width, boy: c.height, sol: r.left, ust: r.top, g: r.width, y: r.height };
    });
  }
  await sleep(2500);
  const durum = await sayfa.evaluate(() => (document.getElementById('status') || {}).textContent || '');
  if (!tuval) {
    not('SONUÇ', 'akış açılmadı (tuval yok). durum: ' + durum + ' hatalar: ' + hatalar.join(' | '));
    await tarayici.close();
    return;
  }
  const eb = ekranBoyu();
  not('akış', `video ${tuval.en}x${tuval.boy}, Android ${eb ? eb.en + 'x' + eb.boy : '?'}, ekranda ${Math.round(tuval.g)}x${Math.round(tuval.y)} @(${Math.round(tuval.sol)},${Math.round(tuval.ust)}) · durum: ${durum}`);
  const sayfaNoktasi = (x, y) => {
    const ox = eb ? tuval.en / eb.en : 1, oy = eb ? tuval.boy / eb.boy : 1;   // Android koordinatı → video koordinatı
    return { px: tuval.sol + (x * ox + 0.5) * tuval.g / tuval.en, py: tuval.ust + (y * oy + 0.5) * tuval.y / tuval.boy };
  };

  const cdp = TARAYICI === 'chrome' ? await baglam.newCDPSession(sayfa) : null;
  async function dokun(px, py, force) {
    if (!cdp) { await sayfa.touchscreen.tap(px, py); return; }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py, force, id: 1 }] });
    await sleep(70);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async function kaydir(x0, y0, x1, y1, force, adim = 12) {
    if (!cdp) return false;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, force, id: 1 }] });
    for (let i = 1; i <= adim; i++) {
      await sleep(16);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / adim, y: y0 + (y1 - y0) * i / adim, force, id: 1 }] });
    }
    await sleep(30);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return true;
  }

  // 1) Dokunma (iPhone: force=0) ve 2) Android Chrome benzeri (force=1)
  const denemeler = TARAYICI === 'chrome' ? [['dokunma force=0 (iPhone gibi)', 0], ['dokunma force=1 (Android Chrome gibi)', 1]] : [['dokunma (WebKit iPhone 15 Plus)', null]];
  for (const [ad, force] of denemeler) {
    ayarlariAc();
    await sleep(1500);
    const h = hedef();
    if (!h) { not(ad, 'hedef bulunamadı'); continue; }
    const once = odak();
    const n0 = giden.length;
    const { px, py } = sayfaNoktasi(h.x, h.y);
    await dokun(px, py, force);
    await sleep(2500);
    const sonra = odak();
    const msj = giden.slice(n0).map((m) => `${['DOWN', 'UP', 'MOVE'][m.eylem]}(${m.x},${m.y} ${m.en}x${m.boy} p=${m.basinc})`).join(' ');
    not(ad, `${sonra !== once ? 'GEÇTİ — Android açtı' : 'KALDI — Android tepki vermedi'} · "${h.metin}" · gönderilen: ${msj || 'yok'} · ${sonra.slice(-70)}`);
  }

  // 3) Kaydırma: üst kenardan aşağı çekince bildirim perdesi açılmalı (MOVE olayları)
  if (cdp) {
    ayarlariAc();
    await sleep(1500);
    const bas = sayfaNoktasi(eb.en / 2, 4), son = sayfaNoktasi(eb.en / 2, eb.boy * 0.6);
    const n0 = giden.length;
    await kaydir(bas.px, bas.py, son.px, son.py, 0);
    await sleep(1500);
    const p = pencere();
    const hareket = giden.slice(n0).filter((m) => m.eylem === 2).length;
    not('kaydırma force=0 (bildirim perdesi)', `${/NotificationShade|StatusBar/i.test(p) ? 'GEÇTİ — perde açıldı' : 'KALDI'} · ${hareket} MOVE · ${p.slice(-60)}`);
    adb('shell', 'cmd', 'statusbar', 'collapse');

    // 4) Liste kaydırma: Ayarlar listesi yukarı kaymalı
    ayarlariAc();
    await sleep(1500);
    const once = hedef();
    const a = sayfaNoktasi(eb.en / 2, eb.boy * 0.8), b = sayfaNoktasi(eb.en / 2, eb.boy * 0.3);
    await kaydir(a.px, a.py, b.px, b.py, 0, 20);
    await sleep(1500);
    const d = arayuz().find((n) => once && n.metin === once.metin);
    not('liste kaydırma force=0', `${!d || Math.abs(((d.y0 + d.y1) / 2) - once.y) > 40 ? 'GEÇTİ — liste kaydı' : 'KALDI'} · "${once && once.metin}" y ${once && once.y} → ${d ? Math.round((d.y0 + d.y1) / 2) : 'görünmüyor'}`);
  }

  // 5) Fare (masaüstü): uygulamanın kendi fare yolu çalışmaya devam etmeli
  if (hatalar.length) not('sayfa hataları', hatalar.slice(0, 3).join(' | '));
  await baglam.close();                              // aynı cihaza ikinci akış açılmadan önce ilkini kapat
  await sleep(1500);
  if (TARAYICI === 'chrome') {
    const masaustu = await tarayici.newContext({ viewport: { width: 1280, height: 800 } });
    const s2 = await masaustu.newPage();
    await s2.goto(url);
    let t2 = null;
    for (let i = 0; i < 60 && !t2; i++) {
      await sleep(500);
      t2 = await s2.evaluate(() => { const c = document.querySelector('.touch-layer'); if (!c || !c.width) return null; const r = c.getBoundingClientRect(); return { en: c.width, boy: c.height, sol: r.left, ust: r.top, g: r.width, y: r.height }; });
    }
    await sleep(2000);
    ayarlariAc();
    await sleep(1500);
    const h = hedef();
    if (t2 && h) {
      const once = odak();
      await s2.mouse.click(t2.sol + (h.x * t2.en / eb.en + 0.5) * t2.g / t2.en, t2.ust + (h.y * t2.boy / eb.boy + 0.5) * t2.y / t2.boy);
      await sleep(2500);
      not('fare tıklaması (masaüstü)', odak() !== once ? 'GEÇTİ' : 'KALDI');
    } else {
      not('fare tıklaması (masaüstü)', 'akış/hedef yok');
    }
  }
  const log = adb('logcat', '-d', '-t', '400');
  const scrcpy = log.split('\n').filter((l) => /scrcpy|Ignore|different device size/i.test(l)).slice(-4).map((l) => l.slice(-110)).join(' ⏎ ');
  if (scrcpy) not('scrcpy günlüğü', scrcpy);
  await tarayici.close();
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY || '/dev/null', `### ${ETIKET}\n\n${sonuc.map((s) => '- ' + s).join('\n')}\n\n`);
})().catch((e) => { console.log(`::error title=${ETIKET}::${String(e && e.stack || e).slice(0, 400)}`); process.exit(1); });
