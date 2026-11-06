# timtools-visual_tests

Pont **code → design**. Des tests système Rails visitent l'application, s'arrêtent sur un
état intéressant et le capturent :

- en **PNG**, pour une revue humaine et des avant/après ;
- en **JSON**, pour le plugin Figma `layers-importer` qui reconstruit l'arbre de calques
  sur le canvas.

Ce n'est pas un outil de test de régression au sens strict : c'est un outil de **synchro
design/code** et une **documentation visuelle de l'état réel de l'app**.

Préfixée `timtools-` comme les autres outils transverses : le nom à trait d'union est la
convention RubyGems pour un namespace, d'où le module `Timtools::VisualTests`. Le code est
public, mais la gem n'est pas publiée sur RubyGems (`allowed_push_host: "none"`) : les
projets la consomment par `git:` ou `path:`.

## Installation

```ruby
# Gemfile du projet hôte
#
# Un groupe dédié plutôt que :test. C'est un outil local : ni la CI ni la production n'en
# ont besoin. Avec un groupe à part, `BUNDLE_WITHOUT=visual` suffit à l'en tenir à
# l'écart — vérifié : Bundler ne clone alors même pas la source git.
#
# Rails ne requiert que les groupes :default et l'environnement courant, donc un groupe
# nommé autrement n'est jamais chargé au boot : c'est le fichier de test qui fait le
# `require`.
group :visual do
  gem "timtools-visual_tests", git: "https://github.com/TimBoing/timtools-visual_tests.git", branch: "main"
end
```

En développement local, pour éditer la gem sans passer par un commit/push à chaque essai :

```bash
bundle config local.timtools-visual_tests <chemin/vers/ton/clone>
```

Bundler lit alors ton clone local tout en gardant la source Git déclarée. Il exige que le
clone soit sur la branche déclarée dans le `Gemfile` — c'est volontaire, ça évite de livrer
depuis une branche de brouillon.

## Mise en place dans un projet

Une classe de base, dans `test/visual/visual_test_case.rb` :

```ruby
require "application_system_test_case"
require "timtools/visual_tests"

Timtools::VisualTests.configure do |config|
  config.root = Rails.root.join("test/visual")
  config.default_viewport = [390, 844] # iPhone 14 ; [1512, 982] pour un produit desktop
end

class VisualTestCase < ApplicationSystemTestCase
  include Timtools::VisualTests::Capture

  using = ENV["CHROME_TESTS"] == "head" ? :chrome : :headless_chrome

  if (metrics = Timtools::VisualTests.device_metrics)
    driven_by :selenium, using: using, screen_size: Timtools::VisualTests.viewport do |options|
      options.add_emulation(device_metrics: metrics)
    end
  else
    driven_by :selenium, using: using, screen_size: Timtools::VisualTests.viewport
  end
end
```

La gem ne déclare **ni classe de base ni driver** : chaque projet garde les siens. Elle
apporte les méthodes de capture et la gestion des dossiers.

Puis un test, qui ressemble à n'importe quel test système :

```ruby
require_relative "../visual_test_case"

class FlashesVisualTest < VisualTestCase
  test "flash de refus sur la page de connexion" do
    visit new_user_session_path
    fill_in "user_email", with: "inconnu@example.com"
    fill_in "user_password", with: "faux"
    click_on "Se connecter"

    freeze_animations!
    screenshot "devise/flashes/01_invalid_credentials", full: false
  end
end
```

Une tâche rake, dans `lib/tasks/visual.rake` du projet :

```ruby
begin
  require "timtools/visual_tests"
  load Timtools::VisualTests.rake_task_path
rescue LoadError
  # Gem absente (CI, production) : pas de tâche visuelle, et c'est très bien.
end
```

Enfin, exclure `test/visual` du `rails test` par défaut, dans `bin/rails` :

```ruby
ENV["DEFAULT_TEST_EXCLUDE"] ||= "test/{system,visual}/**/*_test.rb"
```

…et ignorer les sorties, dans `.gitignore` :

```
/test/visual/screenshots/*
/test/visual/figma/*
```

## Utilisation

```bash
bin/rails test:visual                               # PNG, viewport par défaut
SCREENSHOT_FORMAT=json  bin/rails test:visual       # export Figma seul
SCREENSHOT_FORMAT=both  bin/rails test:visual       # les deux
VISUAL_VIEWPORT=1512x982 bin/rails test:visual      # autre viewport
VISUAL_BASELINE=1 bin/rails test:visual             # écrit dans baseline/ au lieu de current/
TEST=test/visual/flashes_test.rb bin/rails test:visual
```

### Avant / après

1. Sur `main`, avant la modification : `VISUAL_BASELINE=1 bin/rails test:visual`
   → `test/visual/screenshots/baseline/`
2. Implémenter le changement.
3. Recapturer : `bin/rails test:visual` → `test/visual/screenshots/current/`
4. Comparer, par exemple avec ImageMagick :
   `compare -metric RMSE baseline/x.png current/x.png diff.png`

Un viewport non par défaut écrit dans un dossier suffixé (`current_1512x982`) : les
captures de référence ne sont jamais écrasées par un run mobile ou desktop de passage.

## L'API

| Méthode | Rôle |
|---|---|
| `screenshot(name, full: true)` | Capture selon `SCREENSHOT_FORMAT`. En `both`, le PNG passe d'abord (l'export Figma mute le DOM) |
| `save_png(name, full: true)` | PNG seul. `full: false` garde le viewport — pour une modale, un toast, tout ce qui est ancré à l'écran |
| `figma_export(name, selector: "body")` | JSON Figma seul |
| `freeze_animations!` | Fige animations et transitions. Nécessaire pour capturer ce qui s'efface tout seul |
| `mobile?` | Vrai sur un viewport autre que celui de référence du projet |

Les noms acceptent des sous-chemins (`"devise/flashes/01_invalid"`) : l'arborescence des
captures peut ainsi refléter celle des vues.

## Le volet Figma

`html-to-figma` convertit le DOM en arbre de calques (FRAME / RECTANGLE / TEXT).
`figma_capture.js` enrichit ce résultat avec ce que la lib laisse tomber ou lit de travers :
noms de classes, graisses, fond du body, opacité, dégradés, couleurs SVG, glyphes Font
Awesome rasterisés, contrôles de formulaire natifs, images inlinées en base64, et remontée
des `position: fixed` à la racine pour préserver le z-order.

Le JSON produit est consommé par le plugin Figma `layers-importer`. **En modifiant la forme du JSON, il faut
rester compatible avec ce que le plugin attend** — c'est le contrat entre les deux moitiés
du pont.

### Bugs connus et leurs correctifs

| Bug | Cause | Correctif |
|---|---|---|
| Éléments `all: unset; display: inline` (ex. `<button>`) → coordonnées (0,0) | `html-to-figma` lit mal le bounding rect des éléments inline | `fixCoordinates` compare `__pageRect` aux coordonnées déclarées et corrige au-delà de 20px d'écart |
| `<form>` transparent aplati → enfants promus sans ajustement de coordonnées | `html-to-figma` supprime les conteneurs transparents | `fixCoordinates` corrige les enfants du delta inverse |
| `border-radius: 50%` → `cornerRadius: 50` au lieu d'un cercle | La lib comme `getComputedStyle` renvoient la chaîne `"50%"` ; `parseFloat` donne 50 | `enrich` détecte le `%`, le résout contre `min(w,h)` et pose `__pctRadius` → `applyComputedRadius` utilise 999 |
| Icône FA en `position: absolute` retombe dans le flux après rasterisation | Le sélecteur `i { position: absolute }` ne matche plus un `<img>` | `rasterizeFontAwesome` recopie `position/top/right/bottom/left` avant le `replaceWith` |
| Modale Bootstrap en cours de transition → opacité fausse | `.modal.fade.show` a la classe mais la transition de 300ms n'est pas finie | `sleep 0.4` après le `find(".show")`, ou `freeze_animations!` |

## Licence

MIT, voir `LICENSE`. `lib/timtools/visual_tests/assets/html_to_figma.js` est une copie de
`@builder.io/html-to-figma` (MIT, © Builder.io), voir `THIRD_PARTY_LICENSES`.
