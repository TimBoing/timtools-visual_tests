# frozen_string_literal: true

require_relative "lib/timtools/visual_tests/version"

Gem::Specification.new do |spec|
  spec.name = "timtools-visual_tests"
  spec.version = Timtools::VisualTests::VERSION
  spec.authors = ["Timothee Boingneres"]
  spec.email = ["58359423+TimBoing@users.noreply.github.com"]

  spec.summary = "Capture d'etats d'UI depuis les tests systeme Rails : PNG et export Figma."
  spec.description = <<~TEXT
    Pont code -> design. Les tests systeme visitent l'application, s'arretent sur un etat
    interessant et le capturent : en PNG pour un avant/apres humain, en JSON pour le plugin
    Figma "layers-importer" qui reconstruit l'arbre de calques sur le canvas.

    Ce n'est PAS un outil de regression visuelle : rien n'echoue, rien n'est compare
    automatiquement. C'est un outil de synchro design/code et de documentation visuelle.
  TEXT
  spec.homepage = "https://github.com/TimBoing/timtools-visual_tests"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.1"

  # Consommee par git:, jamais publiee : refuse toute publication accidentelle sur rubygems.org.
  spec.metadata["allowed_push_host"] = "none"
  spec.metadata["source_code_uri"] = spec.homepage

  # Pas de `git ls-files` : la gemspec est lue par Bundler avant que le depot ne soit
  # forcement dans un etat propre (et depuis un checkout git: sans .git utilisable).
  spec.files = Dir[
    "lib/**/*.rb",
    "lib/timtools/visual_tests/assets/*.js",
    "lib/timtools/visual_tests/tasks/*.rake",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_LICENSES"
  ]
  spec.require_paths = ["lib"]

  # Le socle Rails du projet hote. La gem n'ajoute aucun driver : elle utilise celui que
  # le projet a deja declare (Selenium, en general).
  spec.add_dependency "capybara", ">= 3.36"
  spec.add_dependency "railties", ">= 7.0"
end
