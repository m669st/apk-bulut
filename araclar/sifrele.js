// Jetonu ve oturum linklerini açan özel anahtarı bir şifreyle şifreleyip
// başlatma sitesinin config.js dosyasını üretir. Jeton bu bilgisayardan çıkmaz;
// sitede (public) yalnızca şifreli hâli durur.
// Kullanım: node araclar\sifrele.js      (GHUSER ortam değişkeni varsa kullanıcı adı sorulmaz)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const ITER = 600000;
const CIKTI = path.resolve(__dirname, '..', '..', 'apk-bulut-site', 'config.js');
const DEPO_ADI = 'apk-bulut';

function sor(soru, gizli = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (gizli) {
      rl._writeToOutput = (s) => {
        if (s.includes(soru)) rl.output.write(s);
        else if (s === '\r\n' || s === '\n') rl.output.write(s);
        else rl.output.write('*'.repeat(s.length));
      };
    }
    rl.question(soru, (cevap) => { rl.close(); if (gizli) process.stdout.write('\n'); resolve(cevap.trim()); });
  });
}

// Oturum linklerinin şifrelendiği ECDH P-256 anahtar çifti. Açık anahtar iş akışına girdi
// olarak gider (açık olabilir); özel anahtar yalnızca şifreli config.js içinde durur.
function anahtarCifti() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { jwk, pub: pub.toString('base64url') };
}

// Tarayıcıdaki WebCrypto ile açılabilen biçim: PBKDF2-SHA256 → AES-256-GCM (şifreli veri + etiket).
// Şifreli içerik: {"t": jeton, "k": özel anahtar (JWK), "p": açık anahtar (base64url)}
function sifrele(token, sifre, repo, cift = anahtarCifti()) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const anahtar = crypto.pbkdf2Sync(sifre, salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', anahtar, iv);
  const icerik = JSON.stringify({ t: token, k: cift.jwk, p: cift.pub });
  const veri = Buffer.concat([c.update(icerik, 'utf8'), c.final(), c.getAuthTag()]);
  return {
    repo,
    iter: ITER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    veri: veri.toString('base64'),
  };
}
module.exports = { sifrele, anahtarCifti };

async function gh(yol, token) {
  const res = await fetch('https://api.github.com' + yol, {
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token },
  });
  return res.status;
}

if (require.main === module) (async () => {
  let kullanici = (process.env.GHUSER || '').trim();
  if (!kullanici) {
    try { kullanici = execSync('gh api user --jq .login', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* gh yok */ }
  }
  if (!kullanici) kullanici = await sor('GitHub kullanıcı adın: ');
  const repo = kullanici + '/' + DEPO_ADI;
  console.log('Depo: ' + repo);

  const token = await sor('Jetonu yapıştır (görünmez): ', true);
  if (!/^github_pat_\w+$/.test(token)) {
    console.error('Bu bir fine-grained jeton gibi görünmüyor (github_pat_ ile başlamalı).');
    process.exit(1);
  }

  console.log('Jeton deneniyor…');
  const r1 = await gh('/repos/' + repo, token);
  const r2 = await gh('/repos/' + repo + '/actions/workflows/android.yml', token);
  if (r1 !== 200 || r2 !== 200) {
    console.error(`Jeton depoya erişemiyor (depo: ${r1}, iş akışı: ${r2}).`);
    console.error('Jeton sayfasında "Only select repositories" altında ' + DEPO_ADI + ' seçili mi, depo gönderildi mi?');
    process.exit(1);
  }

  const sifre = await sor('Site şifresi belirle (en az 10 karakter): ', true);
  if (sifre.length < 10) { console.error('Şifre en az 10 karakter olmalı.'); process.exit(1); }
  const tekrar = await sor('Şifreyi tekrar yaz: ', true);
  if (sifre !== tekrar) { console.error('Şifreler aynı değil.'); process.exit(1); }

  const icerik = 'window.APK_BULUT = ' + JSON.stringify(sifrele(token, sifre, repo), null, 2) + ';\n';
  fs.writeFileSync(CIKTI, icerik);
  console.log('Yazıldı: ' + CIKTI);
})();
