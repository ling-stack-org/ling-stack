<div align="center">
  <img src="apps/web/public/icons/ling-mark.svg" alt="Ling Stack" width="88" height="88" />
  <h1>Ling Stack</h1>
  <p><strong>Réunissez vos coéquipiers IA dans un même espace de projet local.</strong></p>
  <p>Choisissez leurs modèles. Gardez les conversations, les autorisations d'outils et les résultats ensemble.</p>
  <p>
    <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.ja-JP.md">日本語</a> · <a href="README.ko-KR.md">한국어</a> ·
    <a href="README.de-DE.md">Deutsch</a> · Français ·
    <a href="README.es-ES.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <img alt="Alpha depuis les sources" src="https://img.shields.io/badge/Status-source_alpha-5964a0.svg" />
    <a href="LICENSE"><img alt="Licence : MIT" src="https://img.shields.io/badge/License-MIT-08765d.svg" /></a>
    <img alt="Node.js 22.22.1+" src="https://img.shields.io/badge/Node.js-22.22.1%2B-3c873a.svg" />
    <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-f69220.svg" />
  </p>
</div>

> [!NOTE]
> **Version alpha privilégiant l'exécution depuis les sources.** Commencez avec l'interface Web, le daemon local et la CLI.
> L'environnement de développement Desktop est disponible séparément. Il n'existe pas encore d'installateurs stables et signés ni de version de production prise en charge.

## Commencer par une tâche commune

Avec plusieurs modèles, les tâches, les réponses, les demandes d'outils et les résultats peuvent se retrouver dans des fenêtres différentes.
Ling Stack les rassemble dans un canal de projet : attribuez des modèles et des outils aux coéquipiers, examinez leur activité et conservez le résultat avec la conversation.

Essayez une [revue de documents de projet](docs/community/first-project-review.md) au périmètre limité avec deux coéquipiers et un [exemple public](examples/project-review/README.md).
Commencez par la discussion ; ajoutez des outils et des permissions lorsqu'une tâche ultérieure en a besoin.
Votre propre configuration de fournisseur et votre clé API sont nécessaires. Les frais du fournisseur restent à votre charge.

![Interface anglaise de Ling Stack dans un nouvel espace de travail](docs/assets/ling-workspace-home.jpg)

Cette capture réelle montre l'interface anglaise d'un espace local neuf, avant la configuration d'un modèle.
Elle illustre l'organisation de l'espace, pas une tâche achevée. Suivez le guide ci-dessus pour votre première collaboration.

## À qui s'adresse Ling Stack ?

Ling Stack s'adresse aux développeurs et aux personnes qui utilisent plusieurs modèles ou coéquipiers IA et souhaitent garder leur travail au même endroit.
Un Model Workbench commun connecte OpenAI, Anthropic, Volcengine Ark, les points de terminaison compatibles DeepSeek,
MiniMax, GLM et les relais compatibles OpenAI.

L'état de l'espace de travail, l'historique des conversations et les traces d'exécution sont stockés localement.
Les requêtes et leur contexte sont toutefois envoyés aux fournisseurs de modèles ou d'outils que vous choisissez. **Le stockage local ne signifie pas une inférence hors ligne.**
L'interface propose 55 options de langue et de région. La langue de l'interface et celle des réponses de l'IA se configurent séparément.
Le README existe dans les huit langues liées en haut de page. Les autres documents peuvent encore être en anglais ou en chinois.

## Trois façons de l'utiliser

| Scénario | Ce que vous faites | Ce qui reste ensemble |
| --- | --- | --- |
| Interroger un modèle | Configurer un modèle de chat et discuter d'un document, d'une idée ou d'un projet | Messages, choix du modèle, pièces jointes et résultats |
| Travailler avec des coéquipiers IA | Attribuer des modèles et des outils, puis collaborer dans un canal de projet | Participants, activité des outils, autorisations, livrables et rapport final |
| Créer des médias | Configurer une capacité d'image ou de vidéo et utiliser Media Production | Projets, scènes, tâches de génération et sorties |

Commencez par une conversation simple, puis ajoutez des coéquipiers ou des outils selon les besoins.
Les skills fournissent des instructions, mais n'accordent pas automatiquement l'accès aux outils ou aux fichiers.
Les agents de programmation utilisent l'adaptateur d'exécution Pi. Les outils disponibles dépendent de la plateforme et des règles de l'espace de travail.

## Démarrage depuis les sources

Prérequis : Git, **Node.js 22.22.1 ou ultérieur**, et **Corepack avec pnpm 10**.
Le dépôt fixe pnpm à `10.0.0` ; la version de référence de Node pour la CI est `22.22.1`.

### 1. Installer et compiler

```bash
git clone https://github.com/ling-stack-org/ling-stack.git
cd ling-stack
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --workspace-concurrency=1 --filter '@ling-stack/cli...' -r build
```

Cette compilation inclut la CLI, le daemon, l'application Web et leurs dépendances internes. Desktop et Mobile nécessitent une configuration distincte.

### 2. Démarrer le daemon

À la racine du dépôt, lancez cette commande dans un premier terminal et laissez-la active :

```bash
corepack pnpm ling daemon start --foreground
```

L'adresse par défaut est `http://127.0.0.1:17891`. Conservez l'écoute sur l'adresse de boucle locale.

### 3. Ouvrir l'interface Web

Dans un deuxième terminal, depuis la même racine du dépôt :

```bash
corepack pnpm ling ui --foreground --open
```

Si le navigateur ne s'ouvre pas automatiquement, consultez `http://127.0.0.1:5173`.
Dans un autre terminal, `curl http://127.0.0.1:17891/health` doit renvoyer un JSON contenant `"ok": true`.
Cela confirme uniquement le démarrage du service local, pas la disponibilité d'un modèle.

### 4. Connecter un modèle et essayer une conversation

Ouvrez **Settings → Model Workbench**, ajoutez un modèle de chat avec votre propre clé API, puis lancez **Check**.
Le premier modèle de chat dont la vérification réussit devient le modèle par défaut de l'espace de travail.
Posez une petite question dans une nouvelle conversation et examinez la réponse et ses détails.

Après la configuration et la vérification du modèle, exécutez :

```bash
corepack pnpm ling doctor
```

Doctor vérifie la disponibilité des modèles et l'état des services locaux.
Un espace neuf sans modèle de chat signale une erreur de fournisseur même si le daemon et l'interface Web fonctionnent.
Le [guide de démarrage](docs/getting-started.md) explique le premier modèle, la conversation et le canal de projet. Consultez le [dépannage](docs/troubleshooting.md) en cas d'erreur.

## Prise en charge et limites

| Composant ou intégration | Périmètre actuel |
| --- | --- |
| Web, daemon et CLI | Alpha depuis les sources ; parcours de démarrage par défaut |
| Electron Desktop | Environnement de développement ; préparation de la plateforme et validation sur machine vierge restent distinctes |
| Extension Chrome et Browser Host | Intégration de développement locale ; publication sur le Chrome Web Store en attente |
| MCP et Plugin Manager | Attribution explicite des outils, activation et autorisations |
| Fonctions natives Office et Computer Use | Développement dépendant de la plateforme ; consulter les critères d'implémentation et de publication |
| Génération d'images et de vidéos | Dépend du fournisseur et des capacités ; certains adaptateurs réels ont encore des validations ouvertes |
| Mobile | Développement expérimental hors du périmètre actuel de validation du produit |

L'exécution native, l'accessibilité, la signature et la validation des installateurs restent à vérifier pour certaines fonctions.
L'[état d'implémentation](docs/design/implementation-status.md) indique ce qui est réalisé et ce qui reste à valider.
Une compilation réussie ou un test ciblé ne prouve pas qu'un installateur est prêt.

Pour les questions et les bugs reproductibles, lisez le [guide de support](SUPPORT.md) et utilisez les [formulaires GitHub Issue](https://github.com/ling-stack-org/ling-stack/issues/new/choose).
La maintenance est assurée dans la mesure du possible. Signalez les vulnérabilités via le [canal de sécurité](SECURITY.md), sans publier de données sensibles dans les issues publiques.

### Développement Desktop

Sur macOS, les Xcode Command Line Tools avec Swift et `codesign` sont nécessaires.
Sur Windows, le pilote Office nécessite le SDK .NET 8. Les cibles actuelles sont macOS arm64 et Windows x64.
Electron a aussi besoin de son binaire de plateforme ; consultez le [dépannage Desktop](docs/troubleshooting.md#desktop-development).

```bash
corepack pnpm --filter @ling-stack/desktop dev
```

Pour les outils, commandes de compilation et vérifications manuelles, suivez le [guide des paquets de développement Mac et Windows](docs/release/development-packages.md).
Avant de préparer un paquet à distribuer, lisez les [règles de publication et de validation Desktop](docs/release/desktop.md).
La publication du code source et celle de binaires signés sont des étapes distinctes.

## Données et permissions

Les données de l'espace de travail se trouvent par défaut dans `.ling-stack/`, notamment `ling-stack.sqlite`, `sessions/`, `artifacts/` et `logs/`.
Les clés API saisies dans Model Workbench sont enregistrées dans le stockage local de l'espace de travail.
Les variables d'environnement et les références aux trousseaux compatibles sont également disponibles ; voir [configuration et données](docs/getting-started.md#configuration-and-data).

N'incluez pas de clés, de bases de données, de journaux de session ou de résultats privés dans Git ou dans des rapports publics.
Les permissions de l'espace régissent l'accès aux fichiers, les commandes shell, les modifications externes et les générations payantes.
Examinez les demandes avant de les approuver. Pour une migration, utilisez les [opérations de stockage de la CLI](docs/design/workspace-state-storage.md).

## Explorer ou contribuer

Si ce fonctionnement vous est utile, ajoutez une étoile au dépôt pour suivre son évolution.
Indiquez dans les [formulaires Issue](https://github.com/ling-stack-org/ling-stack/issues/new/choose) ce que vous avez essayé, où vous avez rencontré un blocage et si le résultat vous a aidé.

Web (`apps/web`), Desktop (`apps/desktop`) et CLI (`packages/cli`) partagent le daemon (`packages/daemon`).
La logique métier, les contrats, les adaptateurs de fournisseurs et les intégrations d'exécution se trouvent dans `packages/`.

- [Guide de contribution](CONTRIBUTING.md) et [règles de traduction des README](CONTRIBUTING.md#readme-translations) : environnement, vérifications et corrections linguistiques.
- [Première revue de projet](docs/community/first-project-review.md) et [kit communautaire](docs/community/launch-kit.md) : collaboration et retours d'expérience.
- [Architecture](docs/architecture.md) et [Daemon API](docs/daemon-api.md) : limites du système.
- [Index de conception](docs/design/README.md) et [état d'implémentation](docs/design/implementation-status.md) : contrats actuels et critères de validation.
- [Adaptateurs de fournisseurs](docs/provider-adapters.md) et [intégration Pi](docs/pi-coding-agent-integration.md) : modèles et exécution.
- [Politique de publication](docs/release/README.md), [historique des changements](CHANGELOG.md) et [mentions des tiers](THIRD_PARTY_NOTICES.md).

Ling Stack est distribué sous [licence MIT](LICENSE). La participation à la communauté suit le [code de conduite](CODE_OF_CONDUCT.md).
