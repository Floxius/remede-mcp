# Remède MCP — dictionnaire français pour IA

> [!WARNING]
> **État de la source (oct. 2026)** : la base se télécharge depuis l'API officielle de Remède, dont le serveur est **intermittent** (certificat TLS expiré, projet au repos). Si `npm run setup` échoue, réessayez plus tard ou consultez [Dépannage](#dépannage) — le projet amont étant au repos, aucune base plus récente que février 2025 n'existe ; votre installation n'est jamais « dépassée ».

Serveur [MCP](https://modelcontextprotocol.io) (Model Context Protocol) local qui expose le dictionnaire **[Remède](https://github.com/camarm-dev/remede) 1.4.0** à votre assistant IA : **845 318 mots** avec définitions, exemples, synonymes, antonymes, étymologies, pluriels, conjugaisons et rimes phonétiques (IPA).

100 % hors-ligne après installation : la base est ouverte en lecture seule depuis un fichier SQLite local, aucun accès réseau à l'usage.

## Outils exposés

| Outil | Rôle |
|---|---|
| `mot` | Fiche complète : définitions numérotées avec exemples, prononciation IPA, étymologie, pluriels, synonymes/antonymes, sources |
| `definir` | Définitions seules (réponse compacte) |
| `synonymes` / `antonymes` | Listes ciblées |
| `rimes` | Rimes par suffixe phonétique (IPA) : qualité (1-10), syllabes min/max, rimes féminines, élidables, nature grammaticale, pagination |
| `conjuguer` | Tableau complet d'un verbe (indicatif, subjonctif, conditionnel, impératif, participe) |
| `rechercher` | Recherche par préfixe, insensible à la casse et aux accents |
| `aleatoire` | Un mot au hasard avec sa fiche |

Recherche et rimes sont indexées (colonne `phoneme_rev` créée à l'installation) : réponses en quelques millisecondes.

## Installation

Prérequis : **Node.js ≥ 24** (module natif `node:sqlite` ; testé avec Node 26).

```shell
npm install
npm run setup     # télécharge la base (~719 Mo) depuis l'API officielle Remède, ~3 min
```

Puis enregistrez le serveur dans votre client MCP (exemple pour `~/.zcode/cli/config.json`, Claude Desktop, etc.) :

```json
{
  "mcp": {
    "servers": {
      "remede": {
        "command": "node",
        "args": ["<chemin du dépôt>/index.ts"]
      }
    }
  }
}
```

La base est cherchée dans `data/remede.db` du dépôt ; l'environnement `REMEDE_DB` permet de pointer ailleurs.

Options de `setup.mjs` : `--variant remede|remede.en`, `--out <fichier>`. Le script est idempotent — relancer ne retélécharge pas.

> **Note TLS** : le certificat de `api-remede.camarm.fr` était expiré au moment de l'écriture (oct. 2026). `setup.mjs` désactive la vérification TLS **pour ce domaine uniquement**, le temps que le projet Remède le renouvelle.

## Dépannage

Le serveur de l'API officielle est parfois injoignable pendant des heures, puis revient. Dans l'ordre :

1. **Réessayez plus tard** — `npm run setup` (trois tentatives espacées sont déjà intégrées).
2. **Base obtenue par un autre moyen** (copie d'un autre utilisateur, archive) — placez le fichier puis :
   `node setup.mjs --skip-download` (vérifie et crée les index sans télécharger).
3. **Miroir** — `node setup.mjs --url <URL directe du fichier remede.db>`.
4. Base anglaise (variante `remede.en`, plus petite) : `npm run setup -- --variant remede.en --min-words 1`.

Si la source officielle venait à disparaître durablement, ce dépôt hébergerait une copie de la base en release asset (ce qui reste indésirable tant que la source vit, voir ci-dessous).

## Pourquoi la base n'est pas dans le dépôt ?

Trois raisons, dans l'ordre :

1. **Poids** — 818 Mo avec index : hors des usages raisonnables de git et des quotas Git LFS gratuits.
2. **Licences** — les données fusionnées par Remède viennent de sources hétérogènes (voir crédits), dont certaines sans licence explicite. Ce dépôt distribue du code, pas des données : la base est téléchargée par chacun depuis la distribution officielle de Remède.
3. **Fraîcheur** — si Remède publie une base plus récente, `npm run setup` suffit à la récupérer.

## Tests

```shell
npm test          # poignée de main MCP + les 8 outils + vérification anti-résidu HTML
```

## Crédits et licences des données

La base est produite par le projet [Remède](https://github.com/camarm-dev/remede) (code sous licence CeCILL 2.1), qui fusionne ces sources — respectez leurs conditions :

| Donnée | Source | Licence |
|---|---|---|
| Définitions, exemples, étymologies | [Wiktionnaire français](https://fr.wiktionary.org) via [api-definition](https://github.com/LabseStudio/api-definition) (GPL 3.0, original Frederic Gainza) | CC BY-SA 3.0 |
| Synonymes | [synonymo.fr](http://synonymo.fr) | non explicitée |
| Antonymes | [antonyme.org](http://www.antonyme.org) | non explicitée |
| Conjugaisons | [conjuguons.fr](http://conjuguons.fr) / mlconjug3 | non explicitée / — |
| Rimes | [drime](https://a3nm.net/git/drime) (GPL 3.0) sur [Open Lexicon](https://openlexicon.org) | GPL 3.0 / CC BY-SA 4.0 |
| Phonèmes (IPA) | [ipa-dict](https://github.com/open-dict-data/ipa-dict) (fr) | MIT |
| Listes de mots | lorenbrichter/Words ; wiktionaire-fr (drogbadvc) | CC0 1.0 ; non explicitée (dérivé CC BY-SA 3.0) |

Remède n'ajoute pas de restriction propre à ces données : en les utilisant, créditez ces sources et suivez les licences partage-à-l'identique (CC BY-SA) pour tout produit dérivé.

## Licence du code

MIT — voir [LICENSE](LICENSE). Les données téléchargées restent sous les licences de leurs sources respectives ci-dessus.

## État du projet Remède (oct. 2026)

Le projet amont est au repos : dernière release 1.4.0 (déc. 2024), dernière génération de données **23-24 février 2025** (aucune base plus récente n'existe, y compris sur l'API officielle), certificat TLS expiré. Ce serveur MCP reste pleinement fonctionnel avec cette base ; les néologismes postérieurs à début 2025 n'y figurent pas.
