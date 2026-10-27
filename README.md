# Carry Desk · Funding-Arbitrage auf Hyperliquid & Lighter

**Live:** https://grzresearch.github.io/Hyperliquid-Funding-Arbitrage/

Eine statische Seite, die ausrechnet, ob sich delta-neutraler Funding-Carry lohnt – inklusive der echten Kosten für **Entry und Exit beider Legs** (Implementation Shortfall beim Abarbeiten der Orderbücher). Ein hohes Funding auf einem dünnen Buch lohnt sich oft nicht – genau das zeigt die Seite. Drei Ansichten:

| Tab | Was gepaart wird | Position |
|---|---|---|
| **Hyperliquid** | jedes Spot-Paar mit jedem Perp auf demselben Underlying (Main-Dex + alle HIP-3-Dexes) | Long Spot · Short Perp (Reverse bei negativem Funding) |
| **Lighter** | Lighter-Spot (ETH, LIT, LINK, rhSPY, XAUT …) mit Lighter-Perps | wie oben |
| **Cross-DEX** | derselbe Basiswert als Perp auf Hyperliquid *und* auf Lighter | Short, wo das Funding höher ist, Long, wo es niedriger ist – verdient wird die Differenz |

Alle Daten kommen live aus den öffentlichen APIs von [Hyperliquid](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) und [Lighter](https://docs.lighter.xyz/api/websocket), direkt im Browser. Es gibt kein Backend, keine Keys und keinen Build-Schritt.

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

### Lighter

Lighter erlaubt anonymen Clients nur **60 REST-Requests pro Minute** – zu wenig, um hunderte Orderbücher zu pollen. Deshalb kommen Bücher und Funding-Stats über **einen WebSocket**. Ein Buch-Abo liefert einen vollen Snapshot und danach Deltas im 50-ms-Takt; ~180 Bücher dauerhaft zu streamen wären ~700 Nachrichten pro Sekunde. Die Seite **sampelt** deshalb: abonnieren, Snapshot lesen, abbestellen – rotierend, das größte Funding zuerst, wie ein Poll. Das Sampling-Intervall wächst mit der Zahl der Bücher, damit alles unter Lighters Limit von 200 Client-Nachrichten pro Minute bleibt (gedrosselt auf 150). Nur das Paar, das gerade in der Detailansicht offen ist, streamt live; jedes Delta nennt den Nonce, an den es anschließt, bei einer Lücke wird neu abonniert. Die Stats aller Märkte (`market_stats/all`) werden einmal pro Zyklus als Snapshot gelesen. REST bleibt für Markt-Metadaten (1 Request pro Zyklus), Funding-Historie und Kerzen.

- **Funding** ist dieselbe Form wie auf Hyperliquid, aber der Multiplikator (Krypto 1, RWA ½, Pre-IPO 1/100) skaliert nur Premium und Clamp, nicht den Zins; gedeckelt wird je Markt. Realwerte (Aktien, Pre-IPO) laufen zusätzlich mit reduziertem Zins (0,0032 % statt 0,01 % je 8 h) – daran erkennt die Seite die Kategorie; Krypto-Parameter bedeuten einen Token, auch mit kleinem Multiplikator allein (`XTEN`) oder unter einem Rohstoff-Ticker (`GAS`). Im Cross-Tab entscheidet diese Marktklasse, nicht der Growth Mode, den HIP-3-Dexes auch Krypto-Token geben (`io:PRL`). Lighter druckt Raten in Prozent pro Stunde, abgeschnitten auf 0,0001 %; die Premium ist das laufende Stunden-Mittel, bereits mit dem Multiplikator skaliert. Damit reproduziert die Seite alle gedruckten Raten exakt (Test gegen echten Snapshot). Impact-Notional: 500 USDC / Initial-Margin-Fraction bei maximalem Hebel (live verifiziert: BTC, ETH, SPY, FX $25k).
- **Nicht handelbare Märkte** (reduce-only in Abwicklung, eingefroren, versteckt) werden ausgeschlossen, ebenso Liquid-Restaking-Token wie `weETH`.
- **Robinhood-Stock-Token** (`rhSPY`, `rhQQQ`) verbriefen pro Token etwas mehr als eine Aktie (reinvestierte Dividenden, Multiplikator ≈ 1,0017); der Preisvergleich mit dem Perp rechnet je Aktie. Neben dem eigenen Perp sichern sie sich auch über die Index-Perps ab (`rhSPY` ↔ `US500` ×10,03, `rhQQQ` ↔ `US100` ×41,1, als Proxy).
- **Gebühren:** Standard-Account 0/0 (300 ms Taker-Verzögerung), Plus 0,5 bps, Premium 0,4/2,8 bps abzüglich LIT-Staking-Rabatt.

### Cross-DEX-Matching

Lighter-Ticker werden in Hyperliquid-Namen übersetzt (`XAU` → `GOLD`, `WTI` → `CL`, `EURUSD` → `EUR`, `SKHYNIXUSD` → `SKHX`, `OPENAI` → `OAI`, `US500` → `SP500` …), Kontraktgrößen umgerechnet (`1000PEPE` = `kPEPE`), ETF- und Index-Skalen über die Proxy-Klassen verbunden (Lighter `SPY` ↔ `mkts:US500`). Jedes Paar muss im Preis übereinstimmen (±5 %, Proxies ±3 %): `QNT` ist auf Lighter ein Token, auf `xyz` eine Aktie – das fällt heraus.

## Die Rechnung

Für eine Positionsgröße *N* je Leg (beide Legs gleich groß in USD, das ist bei Proxies und `k`-Kontrakten automatisch richtig):

**Implementation Shortfall je Leg.** Eine Market-Order über *q = N / Mid* wird durch das L2-Buch gelaufen und gegen das Mid zum Entscheidungszeitpunkt gemessen:

```
Spread = q_gefüllt · |Best − Mid|          (halber Spread)
Impact = |Σ px·sz − q_gefüllt · Best|      (Abarbeiten der Levels)
Gebühr = Σ px·sz · Taker-Rate
Kosten = Spread + Impact + Gebühr          → in bps von N
```

Das gilt für alle vier Orders: Spot-Entry, Perp-Entry, Spot-Exit und Perp-Exit (Cross-DEX: Entry und Exit auf beiden Börsen). Der Exit wird mit dem heutigen Buch geschätzt. Hyperliquid liefert nur 20 Levels je Seite; reicht das nicht, wird das Buch mit einem `nSigFigs`-aggregierten Snapshot verlängert. Hyperliquid rundet aggregierte Bids ab und Asks auf, deshalb ist die Verlängerung konservativ. Lighter liefert das volle Buch; gerechnet wird bis ±10 % um den besten Kurs (darüber stehen nur Stub-Quotes).

**Maker statt Taker.** Je Leg wählbar: Eine Limit-Order am besten Kurs spart den halben Spread und zahlt die niedrigere Maker-Gebühr – aber nur auf dem Teil, der gefüllt wird. Die Seite simuliert das je Order. Für Einheit *u* der Order (FIFO hinter der Queue *x₀* am besten Kurs) müssen zwei Dinge passieren:

```
Preis:   m(u)    = d0 + Y · σ · √((x₀ + u) / λ)     Distanz, die der faire Preis auf die Order zulaufen muss
         P_P(u)  = erfc(m / (σ · √(2T)))            Reflexionsprinzip: Wahrscheinlichkeit, das in T zu schaffen
Volumen: P_V(u)  = P(Volumen auf meiner Seite in T ≥ u)   Anteil der Zeitfenster der letzten 24 h, die so viel gehandelt haben
         P(u)    = P_P(u) · P_V(u), monoton fallend in u (FIFO)

E[φ]    = ∫ P(u) du / q                              erwarteter Fill-Anteil
Kosten  = −d0 · E[φ]                                  halber Spread, verdient auf Fills
        + ∫ (m(u) + ψ) · P(u) du / q                  Adverse Selection (ψ: der Preis läuft nach dem Fill weiter)
        + E[Market-Order für q − F]                   Rest nach T, gemittelt über die Fill-Verteilung
        + Maker-Gebühr auf Fills, Taker-Gebühr auf den Rest
```

d0 ist der Abstand des besten Kurses vom Mid, σ die Volatilität (aus 5-Minuten-Schritten der 1-Minuten-Kerzen der letzten 24 h; Lighter liefert höchstens die letzten 500 Minuten), λ der marktfähige Flow je Seite (Median der gleitenden Stunden – Ausreißer-Stunden kommen beim Warten nicht wieder). Y · σ · √(v/λ) ist die Preisbewegung, die mit Volumen *v* auf einem Level einhergeht (Square-Root-Skalierung); die Queue vor dir muss nicht komplett handeln, sie storniert großteils, wenn sich der Preis bewegt. Gefüllt wird genau dann, wenn sich der Preis gegen die Order bewegt: Gegeben ein Fill steht er im Mittel *m* weiter (Optional Stopping) – diese Adverse Selection wird einmal gezählt. Das echte Tape zeigt zusätzlich, dass der Preis nach einem Fill noch einige Sekunden weiterläuft (BTC −0,8 bps nach 5–10 s); das kommt als ψ = 0,25 · σ · √10 s dazu. Kalibriert ist das an einem Queue-Backtest: 63 000 Limit-Orders, nachgespielt gegen aufgezeichnete Hyperliquid-Orderbücher und Trades (BTC, SOL, LINK, AVAX, LTC, FIL, EIGEN, dünne HIP-3- und Spot-Märkte; 1, 5 und 15 min Wartezeit). Y = 0,35 minimiert den Kostenfehler (die Daten grenzen es nur auf 0,25–0,5 ein); die Volumen-Verteilung wurde out-of-sample auf 59 Stunden × 10 Märkten geprüft (mittlerer Kalibrierfehler 1,6 Prozentpunkte). Bis die Kerzen eines Markts geladen sind, rechnet die Seite mit 60 % des 24-h-Durchschnitts (so viel wie die Median-Stunde typischerweise) und markiert das als Schätzung. Das Modell ist eine Erwartung: Auf BTC liegen die Kosten in Replays innerhalb von ±0,5 bps der Realität, den Fill-Anteil schätzt es in ruhigen Phasen um 0,05–0,14 zu hoch; bei Altcoins dominiert, wie viel Flow in den nächsten Minuten tatsächlich kommt (realisiert 0,1–3× der Schätzung), mit Kostenfehlern von 1–2 bps in beide Richtungen. Ein Maker-Perp-Leg nimmt nur mit dem Rest Liquidität aus dem Buch und verschiebt entsprechend weniger Funding.

**Carry über die Haltedauer *H*** (1 h bis 90 T – Funding springt schnell, kurze Haltedauern sind gleichwertige Szenarien):

```
Funding  = N · |r| · H          r = stündliche Rate (aktuell, Ø 24 h oder Ø 7 T)
                                Cross-DEX: r = r_Short − r_Long
Basis    = N · Basis_bps        nur im Szenario „konvergiert“
Netto    = Funding + Basis − Kosten
Break-even = Kosten / (N · |r|)
Kapital  = N · (1 + 1/Hebel)    Cross-DEX: N · 2/Hebel (Margin auf beiden Börsen)
```

**Funding bei deiner Größe.** Hyperliquid rechnet `Funding = m · (P + clamp(I − P, ±c)) / 8`. P ist der Premium-Index aus den Impact-Preisen des Perp-Buchs ($6k Notional, $20k bei BTC/ETH). Auf HIP-3 ist P der Mittelwert beider Impact-Preise; auf dem Main-Dex zählen nur Impact-Preise jenseits des Oracles. Die Seite rekonstruiert P aus dem Buch; das stimmt live exakt mit `ctx.premium` überein. Danach nimmt sie die Liquidität heraus, die dein eigener Perp-Order verbraucht, und rechnet das Funding neu. Drei Folgen daraus:
- Solange P im Clamp-Band bleibt, ändert sich nichts. Funding auf dem Zins-Basiswert (10,95 % p.a. auf dem Main-Dex) kann dein Short nicht drücken.
- Auf dem Main-Dex kann ein Short das Funding höchstens bis auf diesen Basiswert drücken.
- Wie lange der Effekt anhält, ist einstellbar:
  - **realistisch** (Standard): der Effekt zählt im Verhältnis deiner Größe zum Stunden-Volumen des Perps. Ein Markt, der stündlich ein Vielfaches deiner Order handelt, füllt das Buch längst wieder auf.
  - **konservativ**: die verbrauchte Liquidität kommt nie zurück (Obergrenze).
  - **ignorieren**: der eigene Einfluss bleibt unberücksichtigt.

Die Größen-Kurve und damit die optimale Größe rechnen mit dem Funding, das bei der jeweiligen Größe gilt.

**Optimale Größe.** Das Funding wächst höchstens linear mit *N*, der Shortfall überproportional. Die Seite rechnet die Netto-Kurve über die gesamte sichtbare Tiefe und zeigt die Größe mit dem höchsten Ertrag sowie die größte Größe, die noch im Plus ist. Die Tiefe zählt in Stück, wie der Round Trip sie abarbeitet: *N* / Arrival-Preis Basiseinheiten auf jeder Seite, die er kreuzt; die dünnste Seite begrenzt die Kurve.

**Gebühren** auf Hyperliquid folgen der [offiziellen Formel](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees), für Taker und Maker: Volumen-Tier und Staking-Rabatt sind wählbar. Je Markt kommen der HIP-3-Deployer-Fee-Scale (×2 bei Scale 1), Growth Mode (−90 %), Aligned Quote Assets (USDH: −20 % auf den Protokollanteil) und Stable Pairs (−80 %) hinzu. Lighter: siehe oben.

## Bedienung

- **Positionsgröße, Haltedauer, Funding-Annahme, Basis-Szenario, eigener Funding-Einfluss, Ausführung (Taker/Maker je Leg, Wartezeit), Gebühren und Hebel** wirken auf alle Zeilen aller Tabs.
- Ein Klick auf eine Zeile öffnet die Detailansicht mit
  - der Ertragsaufstellung (Funding, Spread, Impact und Gebühren bis zum Netto),
  - der Shortfall-Tabelle je Leg,
  - der Kurve „Netto über Größe“,
  - dem Liquiditätsprofil beider Bücher,
  - 7 Tagen Funding-Historie (Cross-DEX: der Spread beider Börsen, stundengenau ausgerichtet),
  - der Maker-Simulation je Order (Queue, Gegenflow, σ, Fill-Anteil, Adverse Selection),
  - und den Risiken.
- Alle Einstellungen, der Tab und das geöffnete Paar stehen in der URL, z. B. `#v=x&n=50000&h=8&e=makerA&w=5`. Links lassen sich also teilen.
- Die Seite aktualisiert sich jede Minute und das offene Paar alle 6 Sekunden; nur die Börsen des aktiven Tabs werden geladen. Hyperliquid-Requests laufen über einen gewichtsbasierten Rate-Limiter unter dem Limit von 1200 pro Minute und IP, Lighter-REST bleibt unter 40 von 60 Requests pro Minute.

## Risiken, die die Zahl nicht enthält

Delta-neutral heißt nicht risikofrei:

- Das Funding kann drehen.
- Bridges und Emittenten können ihren Peg verlieren.
- Ein Perp-Short wird bei starkem Anstieg liquidiert; HIP-3-Märkte erlauben oft nur isolierte Margin. Cross-DEX hat zwei getrennte Margin-Konten: Gewinne auf der einen Börse stützen die andere nicht.
- Maker-Orders werden in Erwartung gerechnet; im Einzelfall wird weniger oder mehr gefüllt.
- Aktien-Perps laufen 24/7, die Börse nicht.
- Exit-Bücher können dünner sein als heute.

Die Detailansicht listet die zutreffenden Punkte je Paar auf. Keine Anlageberatung.

## Entwicklung

Keine Abhängigkeiten. Node ≥ 20 reicht für die Tests.

```bash
npm test          # node --test: Buch-Walk, Shortfall, Carry, Funding-Formeln beider Börsen, Fees, Matching (gegen echte API-Snapshots), Maker-Modell, Lighter-Stream, Cross-DEX, Rate-Limiter
npm run serve     # http://localhost:8080
node scripts/snapshot.mjs > tests/fixtures/universe.json   # Test-Fixture aktualisieren
```

```
site/
  index.html, styles.css, favicon.svg
  js/core/      pure Module, im Browser und unter Node identisch
    api.js        Hyperliquid-Info-API-Client mit Retry/Backoff
    ratelimit.js  gewichtsbasierter Token-Bucket
    universe.js   Hyperliquid: Spot + alle Perp-Dexes → einheitliche Markt-Records
    matching.js   Spot ⇄ Perp-Zuordnung (Evidenz + Preisprüfung + Proxy-Klassen)
    book.js       L2-Bücher, Walk, Stitching der aggregierten Tiefe
    shortfall.js  Implementation Shortfall je Order, Round Trip beliebiger Leg-Paare
    execution.js  Maker-Orders: Fill-Wahrscheinlichkeit, Adverse Selection, Rest als Taker
    carry.js      Funding-Ökonomie, Break-even, Größen-Kurve
    funding.js    Funding-Formeln, Premium aus dem Buch, Einfluss der eigenen Order
    fees.js       Hyperliquid-Gebühren (Taker und Maker) nach offizieller Formel
    evaluate.js   Spot/Perp-Paar + Bücher + Annahmen → eine Ergebniszeile
    cross.js      Cross-DEX: Matching und Bewertung zweier Perps
  js/venues/    Börsen-Adapter mit gemeinsamer Schnittstelle
    hyperliquid.js
    lighter.js, lighter-stream.js   REST + WebSocket (Bücher, Stats)
  js/data.js    Live-Daten je Börse: Refresh-Zyklus, Bücher, Historie, Kerzen
  js/ui/        Tabelle, Detailansichten (Spot/Perp, Cross-DEX), SVG-Charts
tests/          node:test-Suites + Fixture
```

## Deployment auf GitHub Pages

Der Workflow `.github/workflows/pages.yml` testet jeden Push und deployt `site/` von `main` nach GitHub Pages. Einmalig nötig: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
