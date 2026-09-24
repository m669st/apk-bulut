#!/usr/bin/env bash
# Başlatma sayfasının okuduğu commit durumunu yazar.
# Kullanım: durum.sh <pending|success|error> <açıklama> [link]
state="$1"
desc="$2"
url="${3:-}"

jq -n --arg s "$state" --arg d "$desc" --arg u "$url" --arg c "android/${GITHUB_RUN_ID}" \
  '{state: $s, description: $d, context: $c} + (if $u == "" then {} else {target_url: $u} end)' \
  | gh api -X POST "repos/${GITHUB_REPOSITORY}/statuses/${GITHUB_SHA}" --input - > /dev/null \
  || echo "::warning::Durum yazılamadı: $state $desc"
