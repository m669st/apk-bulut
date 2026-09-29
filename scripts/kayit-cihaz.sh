# Android içinde root (su 0) ile çalışır: bir uygulamanın verisini arşivler ya da geri koyar.
#   sh kayit-cihaz.sh yedekle <paket>
#       → /data/local/tmp/kb/<paket>/: veri.tar (iç veri), dis.tar (Android/data), obb.tar (Android/obb), sahip
#   sh kayit-cihaz.sh geriyukle <paket>
#       ← aynı dosyalar (adb push ile konur); sahiplik yeni kuruluma çevrilir, SELinux etiketleri yenilenir
# Arşivler sıkıştırılmaz: aynı veri hep aynı baytları verir, kontrol tarafı değişmeyeni yeniden göndermez.
umask 022
islem="$1"
P="$2"
case "$P" in ''|*/*|.*) echo "gecersiz paket" >&2; exit 2 ;; esac
K="/data/local/tmp/kb/$P"
IC="data/data/$P data/user_de/0/$P"
DIS="data/media/0/Android/data/$P"
OBB="data/media/0/Android/obb/$P"
cd / || exit 1

# Bir klasörün doğrudan içindekiler; önbellekler ve lib (APK'nın yerel kitaplık bağlantısı) hariç.
icerik() {
  for d in "$@"; do
    [ -d "$d" ] || continue
    for f in "$d"/* "$d"/.[!.]*; do
      [ -e "$f" ] || [ -L "$f" ] || continue
      case "${f##*/}" in cache|code_cache|lib) continue ;; esac
      echo "$f"
    done
  done
}

# Arşivde saklanan eski sahibi yeni uygulama kimliğine çevirir. Uygulamaya özel gruplar (önbellek 20000+,
# dış depolama 30000+ …) uid ile aynı adımda kaydığı için onlar da aynı farkla kaydırılır.
sahiplik() {
  eski="$1"; yeni="$2"; shift 2
  [ "$eski" = "$yeni" ] && return 0
  fark=$((yeni - eski))
  for kok in "$@"; do
    [ -e "$kok" ] || [ -L "$kok" ] || continue
    find "$kok" | while read -r f; do
      ug=$(stat -c '%u %g' "$f") || continue
      u=${ug% *}; g=${ug#* }
      [ "$u" = "$eski" ] && u=$yeni
      if [ "$g" -ge 10000 ] && [ $(( (g - eski) % 10000 )) -eq 0 ]; then g=$((g + fark)); fi
      chown -h "$u:$g" "$f"
    done
  done
}

yedekle() {
  rm -rf "$K"
  mkdir -p "$K"
  [ -d "data/data/$P" ] || { echo "kurulu degil" >&2; exit 3; }
  {
    echo "ic $(stat -c '%u' "data/data/$P")"
    for d in dis:"$DIS" obb:"$OBB"; do
      [ -d "${d#*:}" ] && echo "${d%%:*} $(stat -c '%u %g %a' "${d#*:}")"
    done
  } > "$K/sahip"
  icerik $IC > "$K/liste.ic"
  [ -s "$K/liste.ic" ] && tar -cf "$K/veri.tar" -T "$K/liste.ic"
  icerik "$DIS" > "$K/liste.dis"
  [ -s "$K/liste.dis" ] && tar -cf "$K/dis.tar" -T "$K/liste.dis"
  icerik "$OBB" > "$K/liste.obb"
  [ -s "$K/liste.obb" ] && tar -cf "$K/obb.tar" -T "$K/liste.obb"
  rm -f "$K"/liste.*
  chmod 755 "$K"
  chmod 644 "$K"/*
  echo tamam
}

geriyukle() {
  [ -d "data/data/$P" ] || { echo "kurulu degil" >&2; exit 3; }
  [ -f "$K/sahip" ] || { echo "sahip bilgisi yok" >&2; exit 4; }
  yeni=$(stat -c '%u' "data/data/$P")
  eski=$(sed -n 's/^ic //p' "$K/sahip")
  am force-stop "$P" > /dev/null 2>&1

  # İç veri: önbellek ve lib dışındaki her şey silinip arşivden konur.
  icerik $IC | while read -r f; do rm -rf "$f"; done
  if [ -f "$K/veri.tar" ]; then
    tar -xf "$K/veri.tar" || exit 5
    sahiplik "$eski" "$yeni" $(icerik $IC)
  fi

  # Android/data ve Android/obb: klasör yoksa aynı izinle yaratılır, içerik arşivden konur.
  for tur in dis obb; do
    if [ "$tur" = dis ]; then d="$DIS"; else d="$OBB"; fi
    satir=$(sed -n "s/^$tur //p" "$K/sahip")
    [ -n "$satir" ] || continue
    set -- $satir
    u=$1; g=$2; izin=$3
    [ "$u" = "$eski" ] && u=$yeni
    if [ "$g" -ge 10000 ] && [ $(( (g - eski) % 10000 )) -eq 0 ]; then g=$((g + yeni - eski)); fi
    mkdir -p "$d"
    chown "$u:$g" "$d"
    chmod "$izin" "$d"
    icerik "$d" | while read -r f; do rm -rf "$f"; done
    if [ -f "$K/$tur.tar" ]; then
      tar -xf "$K/$tur.tar" || exit 5
      sahiplik "$eski" "$yeni" $(icerik "$d")
    fi
  done

  for d in $IC "$DIS" "$OBB"; do
    [ -e "/$d" ] && restorecon -R "/$d" > /dev/null 2>&1
  done
  rm -rf "$K"
  echo tamam
}

case "$islem" in
  yedekle) yedekle ;;
  geriyukle) geriyukle ;;
  *) echo "kullanim: yedekle|geriyukle <paket>" >&2; exit 2 ;;
esac
