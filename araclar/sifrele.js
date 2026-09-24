// Jetonu bir şifreyle şifreleyip başlatma sitesinin config.js dosyasını üretir.
// Jeton bu bilgisayardan çıkmaz; sitede yalnızca şifreli hâli durur.
// Kullanım: node araclar\sifrele.js
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

// Tarayıcıdaki WebCrypto ile açılabilen biçim: PBKDF2-SHA256 → AES-256-GCM (şifreli veri + etiket).
function sifrele(token, sifre, repo) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const anahtar = crypto.pbkdf2Sync(sifre, salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', anahtar, iv);
  const veri = Buffer.concat([c.update(token, 'utf8'), c.final(), c.getAuthTag()]);
  return {
    repo,
    iter: ITER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    veri: veri.toString('base64'),
  };
}
module.exports = { sifrele };

async function gh(yol, token) {
  const res = await fetch('https://api.github.com' + yol, {
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token },
  });
  return res.status;
}

if (require.main === module) (async () => {
  let kullanici = '';
  try { kullanici = execSync('gh api user --jq .login', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* gh yok */ }
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
