#!/usr/bin/env bash
# Tünelin önüne erişim kapısı (Caddy) kurar. Oturuma özel sır olmadan her istek 403 alır.
#   /giris?k=<sır>  → çerez bırakır, <hedef_yol>'a yönlendirir
#   çerezli istek   → 127.0.0.1:<arka_port>'a aktarılır (WebSocket dahil)
# Kullanım: kapi.sh <arka_port> <hedef_yol>     (sır: /tmp/oturum/sir dosyasından)
set -euo pipefail
arka="$1"
hedef="$2"
sir="$(cat /tmp/oturum/sir)"
CADDY_VER="2.11.4"

if [ ! -x /tmp/caddy ]; then
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VER}/caddy_${CADDY_VER}_linux_amd64.tar.gz" \
    | tar -xz -C /tmp caddy
fi

umask 077
cat > /tmp/oturum/Caddyfile <<EOF
{
	admin off
	auto_https off
	log default {
		output file /tmp/oturum/caddy.log
	}
}

:8080 {
	@giris {
		path /giris
		query k=${sir}
	}
	handle @giris {
		header Set-Cookie "apkbulut=${sir}; Path=/; HttpOnly; Secure; SameSite=Lax"
		redir * ${hedef} 302
	}

	@izinli header Cookie *apkbulut=${sir}*
	handle @izinli {
		reverse_proxy 127.0.0.1:${arka}
	}

	handle {
		respond "Yetkisiz" 403
	}
}
EOF

/tmp/caddy validate --config /tmp/oturum/Caddyfile --adapter caddyfile > /tmp/oturum/caddy-validate.log 2>&1 \
  || { echo "::error::Caddy yapılandırması geçersiz"; tail -20 /tmp/oturum/caddy-validate.log; exit 1; }
nohup /tmp/caddy run --config /tmp/oturum/Caddyfile --adapter caddyfile > /tmp/oturum/caddy-run.log 2>&1 &

for i in $(seq 1 50); do
  kod=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)
  [ "$kod" = "403" ] && exit 0
  sleep 0.2
done
echo "::error::Erişim kapısı açılmadı"
exit 1
