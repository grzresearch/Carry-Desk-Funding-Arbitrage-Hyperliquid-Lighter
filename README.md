# Carry Desk · Hyperliquid Spot ⇄ Perp Funding-Arbitrage

**Live:** https://grzresearch.github.io/Hyperliquid-Funding-Arbitrage/

Eine statische Seite, die **jedes Asset auf Hyperliquid mit einem Spot- und einem Perp-Markt** findet und ausrechnet, ob sich der delta-neutrale Funding-Carry lohnt: Long Spot und Short Perp, wenn das Funding positiv ist (Reverse bei negativem Funding). Dabei werden die echten Kosten für **Entry und Exit beider Legs** einbezogen, also der Implementation Shortfall beim Abarbeiten der Orderbücher. Ein hohes Funding auf einem dünnen Buch lohnt sich oft nicht – genau das zeigt die Seite.

Alle Daten kommen live aus der öffentlichen [Hyperliquid Info-API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint), direkt im Browser. Es gibt kein Backend, keine Keys und keinen Build-Schritt.

## Was abgedeckt ist

- **Alle Spot-Paare** (Quotes USDC, USDT0, USDE, USDH) gegen **alle Perp-Dexes**: den Main-Dex und jeden HIP-3-Dex aus `perpDexs` (xyz, para, mkts, io …). Gelistete, aber delistete Märkte werden ignoriert.
- **Tokenisierte Aktien**: EQX (`EQNVDA`, `EQTSLA`, `EQGOOG` …, Handelsstart 26.10.2026), xStocks (`NVDAX`, `MUX` …) und weitere gegen die Aktien-Perps (z. B. `xyz:NVDA`). Vor dem Handelsstart erscheinen sie als „Spot ohne Orderbuch“; die Berechnung startet automatisch, sobald Orders im Buch liegen.
- **Bridges und Wrapper**: Unit (`UBTC` → `BTC`, `UFART` → `FARTCOIN`, `UBONK` → `kBONK` ×1000), LayerZero (`LINK0`), Wagyu (`XMR1`), Omni (`ONEAR`), Flare (`FXRP`) …
- **Proxies** mit expliziter Preisskala: S&P 500 (SPY-Token ↔ `mkts:US500`, `xyz:SP500` ×10), Nasdaq-100 (QQQ ↔ `mkts:USTECH`, `xyz:XYZ100` ×41), Gold (`XAUT0`/`XAUM` ↔ `PAXG`, `xyz:GOLD`).

### Wie das Matching entscheidet

Gleiche Ticker sind kein Beweis. Es gibt viele Squatter-Token (`TRUMP`, `PEPE`, `PUMP` …), und manche Ticker kollidieren zwischen Dexes (`STX` ist Stacks auf dem Main-Dex, aber Seagate auf `para`). Deshalb hat jeder Kandidat eine Evidenzstufe:

| Evidenz | Quelle | Preisprüfung |
|---|---|---|
| stark | Emittenten-Konvention (`EQX Tokenized …`, `Wrapped … xStock`, `Unit …`, `… - Wagyu.xyz`) oder kuratierter Override | nur Ausreißer > 50 % werden verworfen |
| mittel | Affix-Regel, die der Full Name bestätigt (`ONEAR` „NEAR Protocol“), `…0`/`…1`-Bridges | ±15 % |
| schwach | reiner Ticker | ±10 %; bei dünnen Büchern muss der Perp-Preis innerhalb des Spot-Bid/Ask liegen |

Liquid-Staking-Token (`KHYPE`, alles mit „Staked“ im Namen) werden nie 1:1 gematcht.

## Die Rechnung

Für eine Positionsgröße *N* je Leg (beide Legs gleich groß in USD, das ist bei Proxies und `k`-Kontrakten automatisch richtig):

**Implementation Shortfall je Leg.** Eine Market-Order über *q = N / Mid* wird durch das L2-Buch gelaufen und gegen das Mid zum Entscheidungszeitpunkt gemessen:

```
Spread = q_gefüllt · |Best − Mid|          (halber Spread)
Impact = |Σ px·sz − q_gefüllt · Best|      (Abarbeiten der Levels)
Gebühr = Σ px·sz · Taker-Rate
Kosten = Spread + Impact + Gebühr          → in bps von N
```

Das gilt für alle vier Orders: Spot-Entry, Perp-Entry, Spot-Exit und Perp-Exit. Der Exit wird mit dem heutigen Buch geschätzt. Die API liefert nur 20 Levels je Seite; reicht das nicht, wird das Buch mit einem `nSigFigs`-aggregierten Snapshot verlängert. Hyperliquid rundet aggregierte Bids ab und Asks auf, deshalb ist die Verlängerung konservativ.

**Carry über die Haltedauer *H*.**

```
Funding  = N · |r| · H          r = stündliche Rate (aktuell, Ø 24 h oder Ø 7 T)
Basis    = N · Basis_bps        nur im Szenario „konvergiert“
Netto    = Funding + Basis − Kosten
Break-even = Kosten / (N · |r|)
Kapital  = N · (1 + 1/Hebel)
```

**Funding bei deiner Größe.** Hyperliquid rechnet `Funding = m · (P + clamp(I − P, ±c)) / 8`. P ist der Premium-Index aus den Impact-Preisen des Perp-Buchs ($6k Notional, $20k bei BTC/ETH). Auf HIP-3 ist P der Mittelwert beider Impact-Preise; auf dem Main-Dex zählen nur Impact-Preise jenseits des Oracles. Die Seite rekonstruiert P aus dem Buch; das stimmt live exakt mit `ctx.premium` überein. Danach nimmt sie die Liquidität heraus, die dein eigener Perp-Order verbraucht, und rechnet das Funding neu. Drei Folgen daraus:
- Solange P im Clamp-Band bleibt, ändert sich nichts. Funding auf dem Zins-Basiswert (10,95 % p.a. auf dem Main-Dex) kann dein Short nicht drücken.
- Auf dem Main-Dex kann ein Short das Funding höchstens bis auf diesen Basiswert drücken.
- Wie lange der Effekt anhält, ist einstellbar:
  - **realistisch** (Standard): der Effekt zählt im Verhältnis deiner Größe zum Stunden-Volumen des Perps. Ein Markt, der stündlich ein Vielfaches deiner Order handelt, füllt das Buch längst wieder auf.
  - **konservativ**: die verbrauchte Liquidität kommt nie zurück (Obergrenze).
  - **ignorieren**: der eigene Einfluss bleibt unberücksichtigt.

Die Größen-Kurve und damit die optimale Größe rechnen mit dem Funding, das bei der jeweiligen Größe gilt.

**Optimale Größe.** Das Funding wächst höchstens linear mit *N*, der Shortfall überproportional. Die Seite rechnet die Netto-Kurve über die gesamte sichtbare Tiefe und zeigt die Größe mit dem höchsten Ertrag sowie die größte Größe, die noch im Plus ist.

**Gebühren** folgen der [offiziellen Formel](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees): Volumen-Tier und Staking-Rabatt sind wählbar. Je Markt kommen der HIP-3-Deployer-Fee-Scale (×2 bei Scale 1), Growth Mode (−90 %), Aligned Quote Assets (USDH: −20 % auf den Protokollanteil) und Stable Pairs (−80 %) hinzu.

## Bedienung

- **Positionsgröße, Haltedauer, Funding-Annahme, Basis-Szenario, eigener Funding-Einfluss, Fee-Tier und Hebel** wirken auf alle Zeilen.
- Ein Klick auf eine Zeile öffnet die Detailansicht mit
  - der Ertragsaufstellung (Funding, Spread, Impact und Gebühren bis zum Netto),
  - der Shortfall-Tabelle je Leg,
  - der Kurve „Netto über Größe“,
  - dem Liquiditätsprofil beider Bücher,
  - 7 Tagen Funding-Historie,
  - und den Risiken.
- Alle Einstellungen und das geöffnete Paar stehen in der URL, z. B. `#n=50000&h=720&pair=@1155|xyz:NVDA`. Links lassen sich also teilen.
- Die Seite aktualisiert sich jede Minute und das offene Paar alle 6 Sekunden. Die Requests laufen über einen gewichtsbasierten Rate-Limiter, der unter dem Hyperliquid-Limit von 1200 pro Minute und IP bleibt.

## Risiken, die die Zahl nicht enthält

Delta-neutral heißt nicht risikofrei:

- Das Funding kann drehen.
- Bridges und Emittenten können ihren Peg verlieren.
- Ein Perp-Short wird bei starkem Anstieg liquidiert; HIP-3-Märkte erlauben oft nur isolierte Margin.
- Aktien-Perps laufen 24/7, die Börse nicht.
- Exit-Bücher können dünner sein als heute.

Die Detailansicht listet die zutreffenden Punkte je Paar auf. Keine Anlageberatung.

## Entwicklung

Keine Abhängigkeiten. Node ≥ 20 reicht für die Tests.

```bash
npm test          # node --test, 85 Tests: Buch-Walk, Shortfall, Carry, Funding-Formel, Fees, Matching (gegen echten API-Snapshot), Rate-Limiter
npm run serve     # http://localhost:8080
node scripts/snapshot.mjs > tests/fixtures/universe.json   # Test-Fixture aktualisieren
```

```
site/
  index.html, styles.css, favicon.svg
  js/core/      pure Module, im Browser und unter Node identisch
    api.js        Info-API-Client mit Retry/Backoff
    ratelimit.js  gewichtsbasierter Token-Bucket
    universe.js   Spot + alle Perp-Dexes → einheitliche Markt-Records
    matching.js   Spot ⇄ Perp-Zuordnung (Evidenz + Preisprüfung + Proxy-Klassen)
    book.js       L2-Bücher, Walk, Stitching der aggregierten Tiefe
    shortfall.js  Implementation Shortfall je Leg und Round Trip
    carry.js      Funding-Ökonomie, Break-even, Größen-Kurve
    funding.js    Funding-Formel, Premium aus dem Buch, Einfluss der eigenen Order
    fees.js       Taker-Gebühren nach offizieller Formel
    evaluate.js   Paar + Bücher + Annahmen → eine Ergebniszeile
  js/data.js    Live-Daten: Refresh-Zyklus, Bücher, Funding-Historie
  js/ui/        Tabelle, Detailansicht, SVG-Charts
tests/          node:test-Suites + Fixture
```

## Deployment auf GitHub Pages

Der Workflow `.github/workflows/pages.yml` testet jeden Push und deployt `site/` von `main` nach GitHub Pages. Einmalig nötig: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
