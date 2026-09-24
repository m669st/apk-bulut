#!/usr/bin/env bash
# Cloudflare hızlı tüneli açar (hesap gerekmez) ve adresini stdout'a yazar.
# Kullanım: tunel.sh <yerel_port> <kontrol_yolu>   (kontrol_yolu "-" ise erişim beklenmez)
port="$1"
yol="${2:-/}"

nohup /tmp/cloudflared tunnel --no-autoupdate --url "http://localhost:${port}" \
  > /tmp/cloudflared.log 2>&1 &

host=""
for i in $(seq 1 90); do
  # Hızlı tünel adları tireli kelimelerdir; api.trycloudflare.com ile karışmasın.
  host=$(grep -oE 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' /tmp/cloudflared.log \
    | head -1 | sed 's#https://##')
  if [ -n "$host" ]; then break; fi
  sleep 1
done

if [ -z "$host" ]; then
  echo "::error::Cloudflare tüneli açılamadı" >&2
  tail -30 /tmp/cloudflared.log >&2
  exit 1
fi

# Tünel dışarıdan erişilebilir olana kadar bekle (en fazla ~90 sn).
[ "$yol" = "-" ] && { echo "$host"; exit 0; }
for i in $(seq 1 45); do
  kod=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    --doh-url https://1.1.1.1/dns-query "https://${host}${yol}" || true)
  case "$kod" in
    2*|3*|401|403) break ;;
  esac
  sleep 2
done

echo "$host"
