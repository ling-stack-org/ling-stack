<div align="center">
  <img src="apps/web/public/icons/ling-mark.svg" alt="Ling Stack" width="88" height="88" />
  <h1>Ling Stack</h1>
  <p><strong>KI-Teammitglieder in einem gemeinsamen lokalen Projektarbeitsbereich.</strong></p>
  <p>Modelle auswählen und Gespräche, Werkzeugfreigaben und Ergebnisse zusammenhalten.</p>
  <p>
    <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.ja-JP.md">日本語</a> · <a href="README.ko-KR.md">한국어</a> ·
    Deutsch · <a href="README.fr-FR.md">Français</a> ·
    <a href="README.es-ES.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <img alt="Quellcode-Alpha" src="https://img.shields.io/badge/Status-source_alpha-5964a0.svg" />
    <a href="LICENSE"><img alt="Lizenz: MIT" src="https://img.shields.io/badge/License-MIT-08765d.svg" /></a>
    <img alt="Node.js 22.22.1+" src="https://img.shields.io/badge/Node.js-22.22.1%2B-3c873a.svg" />
    <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-f69220.svg" />
  </p>
</div>

> [!NOTE]
> **Alpha mit Schwerpunkt auf dem Betrieb aus dem Quellcode.** Beginne mit Web UI, lokalem Daemon und CLI.
> Die Desktop-Entwicklungsumgebung ist separat verfügbar. Stabile, signierte Installationspakete und eine unterstützte Produktionsversion gibt es noch nicht.

## Mit einer gemeinsamen Aufgabe beginnen

Bei der Arbeit mit mehreren Modellen verteilen sich Aufgaben, Antworten, Werkzeuganfragen und Ergebnisse oft auf verschiedene Fenster.
Ling Stack bündelt sie in einem Projektkanal: Weise Teammitgliedern Modelle und Werkzeuge zu, prüfe ihre Aktivitäten und bewahre Ergebnisse zusammen mit dem Gespräch auf.

Probiere eine klar begrenzte [Prüfung von Projektunterlagen](docs/community/first-project-review.md) mit zwei Teammitgliedern aus.
Ein [öffentliches Beispiel](examples/project-review/README.md) steht bereit. Beginne mit einer Diskussion und ergänze Werkzeuge und Berechtigungen erst, wenn eine Aufgabe sie braucht.
Du benötigst eine eigene Anbieterkonfiguration und einen eigenen API-Schlüssel. Anbieterkosten gehen zu deinen Lasten.

![Englische Ling-Stack-Oberfläche in einem neuen Arbeitsbereich](docs/assets/ling-workspace-home.jpg)

Die Aufnahme zeigt die tatsächliche englische Oberfläche eines neuen lokalen Arbeitsbereichs vor der Modellkonfiguration.
Sie veranschaulicht das Layout, nicht eine abgeschlossene Aufgabe. Der oben verlinkte Leitfaden hilft beim ersten gemeinsamen Versuch.

## Für wen ist Ling Stack gedacht?

Ling Stack richtet sich an Entwickler und andere Menschen, die mit mehreren KI-Modellen oder Teammitgliedern arbeiten und alles an einem Ort behalten möchten.
Die gemeinsame Model Workbench verbindet OpenAI, Anthropic, Volcengine Ark, DeepSeek-kompatible Endpunkte,
MiniMax, GLM und OpenAI-kompatible Relay-Dienste.

Arbeitsbereichsdaten, Gesprächsverlauf und Ausführungsnachweise werden lokal gespeichert.
Anfragen und ihr Kontext werden jedoch an die gewählten Modell- oder Werkzeuganbieter gesendet. **Lokale Speicherung bedeutet keine Offline-Inferenz.**
Die Oberfläche bietet 55 Sprach- und Regionsoptionen; Oberflächensprache und Sprache der KI-Antworten lassen sich getrennt einstellen.
Die README gibt es in den acht oben verlinkten Sprachen. Andere Dokumente können weiterhin auf Englisch oder Chinesisch vorliegen.

## Drei Einsatzmöglichkeiten

| Szenario | Was du machst | Was zusammenbleibt |
| --- | --- | --- |
| Ein Modell befragen | Ein Chatmodell konfigurieren und über Dokumente, Ideen oder Projekte sprechen | Nachrichten, Modellauswahl, Anhänge und Ergebnisse |
| Mit KI-Teammitgliedern arbeiten | Modelle und Werkzeuge zuweisen und in einem Projektkanal zusammenarbeiten | Beteiligte, Werkzeugaktivitäten, Freigaben, Artefakte und Abschlussbericht |
| Medien erstellen | Eine Bild- oder Videofunktion konfigurieren und Media Production verwenden | Projekte, Szenen, Generierungsaufträge und Ausgaben |

Beginne mit einem einfachen Gespräch und ergänze Teammitglieder oder Werkzeuge nach Bedarf.
Skills liefern Anweisungen, gewähren aber nicht automatisch Zugriff auf Werkzeuge oder Dateien.
Coding-Agent-Aufgaben nutzen den Pi-Laufzeitadapter. Verfügbare Werkzeuge hängen von der Plattformkonfiguration und den Richtlinien des Arbeitsbereichs ab.

## Schnellstart aus dem Quellcode

Voraussetzungen: Git, **Node.js 22.22.1 oder neuer** und **Corepack mit pnpm 10**.
Das Repository legt pnpm `10.0.0` fest; die Node-Basisversion der CI ist `22.22.1`.
Der Web-/Daemon-Build benötigt außerdem **Rust ab Version 1.89 und Cargo** für die native Bildbereinigung.
Installation über [rustup](https://rustup.rs/); die CI verwendet Rust `1.97.1`.

### 1. Installieren und bauen

```bash
git clone https://github.com/ling-stack-org/ling-stack.git
cd ling-stack
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --workspace-concurrency=1 --filter '@ling-stack/cli...' -r build
```

Dieser Build umfasst CLI, Daemon, Web-App und ihre Workspace-Abhängigkeiten. Desktop und Mobile benötigen eine separate Einrichtung.

### 2. Daemon starten

Führe diesen Befehl im Repository-Stammverzeichnis im ersten Terminal aus und lasse ihn laufen:

```bash
corepack pnpm ling daemon start --foreground
```

Die Standardadresse ist `http://127.0.0.1:17891`. Beschränke den Dienst auf die Loopback-Adresse.

### 3. Web UI öffnen

Führe im zweiten Terminal im selben Repository-Stammverzeichnis Folgendes aus:

```bash
corepack pnpm ling ui --foreground --open
```

Falls sich der Browser nicht automatisch öffnet, rufe `http://127.0.0.1:5173` auf.
In einem weiteren Terminal sollte `curl http://127.0.0.1:17891/health` JSON mit `"ok": true` zurückgeben.
Das bestätigt nur den laufenden lokalen Dienst, nicht die Einsatzbereitschaft eines Modells.

### 4. Modell verbinden und ein Gespräch ausprobieren

Öffne **Settings → Model Workbench**, füge ein chatfähiges Modell mit deinem eigenen API-Schlüssel hinzu und führe **Check** aus.
Das erste erfolgreich geprüfte Chatmodell wird zum Standardmodell des Arbeitsbereichs.
Stelle in einem neuen Gespräch eine kleine Frage und prüfe die Antwort und ihre Details.

Führe nach der Konfiguration und Prüfung des Modells Folgendes aus:

```bash
corepack pnpm ling doctor
```

Doctor prüft sowohl die Modellbereitschaft als auch den Zustand lokaler Dienste.
Ein neuer Arbeitsbereich ohne Chatmodell meldet einen Anbieterfehler, auch wenn Daemon und Web UI bereits laufen.
[Erste Schritte](docs/getting-started.md) erklärt Modell, Gespräch und Projektkanal. Bei Einrichtungsproblemen hilft die [Fehlerbehebung](docs/troubleshooting.md).

## Unterstützung und Grenzen

| Bereich oder Integration | Aktueller Umfang |
| --- | --- |
| Web, Daemon und CLI | Quellcode-Alpha; der empfohlene Einstieg |
| Electron Desktop | Entwicklungsshell; Plattformvorbereitung und Abnahme auf einem sauberen System bleiben separate Prüfungen |
| Chrome-Erweiterung und Browser Host | Lokale Entwicklungsintegration; Veröffentlichung im Chrome Web Store steht aus |
| MCP und Plugin Manager | Explizite Werkzeugzuweisung, Aktivierung und Freigabegrenzen |
| Native Office- und Computer-Use-Funktionen | Plattformabhängige Entwicklung; maßgeblich sind die dokumentierten Implementierungs- und Freigabeprüfungen |
| Bild- und Videogenerierung | Abhängig von Anbieter und Funktion; bei einigen Live-Adaptern stehen Prüfungen aus |
| Mobile | Experimentelle Entwicklung außerhalb des aktuellen Produktabnahmeumfangs |

Für bestimmte native Funktionen sind Ausführung, Barrierefreiheit, Signierung und Installationsprüfung noch nicht vollständig abgenommen.
Der [Implementierungsstatus](docs/design/implementation-status.md) zeigt, was umgesetzt ist und was noch geprüft werden muss.
Ein erfolgreicher Quellcode-Build oder einzelner Test belegt keine Installationsreife.

Lies für Fragen und reproduzierbare Fehler den [Support-Leitfaden](SUPPORT.md) und nutze die [GitHub-Issue-Formulare](https://github.com/ling-stack-org/ling-stack/issues/new/choose).
Die Wartung erfolgt nach verfügbaren Möglichkeiten. Melde Schwachstellen über den [Sicherheitskanal](SECURITY.md), nicht mit sensiblen Daten in öffentlichen Issues.

### Desktop-Entwicklung

Auf macOS sind Xcode Command Line Tools mit Swift und `codesign` erforderlich; auf Windows das .NET 8 SDK für den Office-Treiber.
Aktuelle Distributionsziele sind macOS arm64 und Windows x64. Electron benötigt außerdem seine plattformspezifische Binärdatei.
Siehe [Desktop-Fehlerbehebung](docs/troubleshooting.md#desktop-development).

```bash
corepack pnpm --filter @ling-stack/desktop dev
```

Plattformwerkzeuge, Build-Befehle und manuelle Prüfungen stehen im [Leitfaden für Mac- und Windows-Entwicklungspakete](docs/release/development-packages.md).
Lies vor der Paketierung zur Weitergabe die [Desktop-Freigabe- und Abnahmeregeln](docs/release/desktop.md).
Die Veröffentlichung des Quellcodes und die Veröffentlichung signierter Binärpakete sind getrennte Schritte.

## Daten und Berechtigungen

Standardmäßig liegen Arbeitsbereichsdaten in `.ling-stack/`, einschließlich `ling-stack.sqlite`, `sessions/`, `artifacts/` und `logs/`.
In der Model Workbench eingegebene API-Schlüssel werden im lokalen Arbeitsbereich gespeichert. Umgebungsvariablen und unterstützte Schlüsselbundreferenzen sind ebenfalls möglich.
Siehe [Konfiguration und Daten](docs/getting-started.md#configuration-and-data).

Halte Schlüssel, Datenbanken, Sitzungsprotokolle und private Ergebnisse aus Git und öffentlichen Berichten heraus.
Arbeitsbereichsberechtigungen regeln Dateizugriff, Shell-Befehle, Änderungen an externen Diensten und kostenpflichtige Generierung.
Prüfe Anfragen vor der Freigabe. Für Speicherumzüge nutze die [CLI-Speicherabläufe](docs/design/workspace-state-storage.md).

## Erkunden und mitwirken

Wenn dir der Ablauf hilft, kannst du das Repository mit einem Star verfolgen. Berichte über die [Issue-Formulare](https://github.com/ling-stack-org/ling-stack/issues/new/choose),
was du versucht hast, wo du nicht weiterkamst und ob das Ergebnis hilfreich war.

Web (`apps/web`), Desktop (`apps/desktop`) und CLI (`packages/cli`) teilen sich den Daemon (`packages/daemon`).
Domänenlogik, Verträge, Anbieteradapter und Laufzeitintegrationen liegen unter `packages/`.

- [Beitragsleitfaden](CONTRIBUTING.md) und [README-Übersetzungsregeln](CONTRIBUTING.md#readme-translations): Einrichtung, Prüfungen und Übersetzungskorrekturen.
- [Erste Projektprüfung](docs/community/first-project-review.md) und [Community-Materialien](docs/community/launch-kit.md): Zusammenarbeit ausprobieren und Rückmeldungen geben.
- [Architektur](docs/architecture.md) und [Daemon API](docs/daemon-api.md): Systemgrenzen.
- [Designindex](docs/design/README.md) und [Implementierungsstatus](docs/design/implementation-status.md): aktuelle Verträge und Abnahmebedingungen.
- [Anbieteradapter](docs/provider-adapters.md) und [Pi-Integration](docs/pi-coding-agent-integration.md): Modelle und Laufzeit.
- [Release-Richtlinie](docs/release/README.md), [Änderungsprotokoll](CHANGELOG.md) und [Drittanbieterhinweise](THIRD_PARTY_NOTICES.md).

Ling Stack steht unter der [MIT-Lizenz](LICENSE). Für die Community gilt der [Verhaltenskodex](CODE_OF_CONDUCT.md).
