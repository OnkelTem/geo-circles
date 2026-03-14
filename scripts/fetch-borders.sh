#!/usr/bin/env bash
# Скачивает данные о странах из REST Countries API
# и сохраняет обработанный JSON в public/data/countries.json
#
# Использование: bash scripts/fetch-borders.sh
# Зависимости: curl, jq

set -euo pipefail

API_URL="https://restcountries.com/v3.1/all?fields=cca3,name,borders,area,population,continents,latlng"
OUT_DIR="public/data"
OUT_FILE="$OUT_DIR/countries.json"
TMP_FILE=$(mktemp)

# --- проверка зависимостей ---
for cmd in curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Ошибка: '$cmd' не установлен." >&2
    exit 1
  fi
done

mkdir -p "$OUT_DIR"

echo "Запрос к REST Countries API..."
curl -fsSL "$API_URL" -o "$TMP_FILE"

echo "Обработка данных..."

# Формирует:
#   nodes — массив вершин с метриками страны
#   links — массив рёбер (уникальные пары соседей, без дублей)
jq '
  # --- nodes ---
  ( map({
      id:         .cca3,
      name:       .name.common,
      area:       (.area       // 0),
      population: (.population // 0),
      continents: (.continents // []),
      lat:        (if .latlng and (.latlng | length) >= 2 then .latlng[0] else null end),
      lng:        (if .latlng and (.latlng | length) >= 2 then .latlng[1] else null end),
      borders:    (.borders    // [])
    }) ) as $countries |

  # --- links (дедупликация: только source < target) ---
  ( $countries
    | map(
        . as $c
        | .borders[]
        | select(. > $c.id)
        | { source: $c.id, target: . }
      )
  ) as $links |

  {
    nodes: ( $countries | map(del(.borders)) ),
    links: $links
  }
' "$TMP_FILE" > "$OUT_FILE"

rm -f "$TMP_FILE"

NODE_COUNT=$(jq '.nodes | length' "$OUT_FILE")
LINK_COUNT=$(jq '.links | length' "$OUT_FILE")

echo "Готово: $OUT_FILE"
echo "  Вершин (стран): $NODE_COUNT"
echo "  Рёбер (границ): $LINK_COUNT"
