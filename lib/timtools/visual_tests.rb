# frozen_string_literal: true

require "timtools/visual_tests/version"
require "timtools/visual_tests/configuration"
require "timtools/visual_tests/capture"

# Pont code -> design : capture des etats d'UI depuis les tests systeme, en PNG (revue
# humaine, avant/apres) et en JSON (plugin Figma "layers-importer").
#
# La gem n'impose ni classe de base ni driver : le projet hote garde son
# ApplicationSystemTestCase et son `driven_by`, et inclut Timtools::VisualTests::Capture.
module Timtools
  module VisualTests
    class << self
      def configuration
        @configuration ||= Configuration.new
      end

      def configure
        yield(configuration)
      end

      # Viewport effectif. VISUAL_VIEWPORT=414x896 surcharge le defaut du projet.
      def viewport
        @viewport ||= begin
          raw = ENV["VISUAL_VIEWPORT"]
          raw ? raw.split("x").map(&:to_i) : configuration.default_viewport
        end.freeze
      end

      def default_viewport?
        viewport == configuration.default_viewport
      end

      # Chrome applique un plancher de largeur de fenetre (~500px) : demander 390 de large
      # donne une capture de 500. En dessous du plancher on emule les metriques du device,
      # ce qui fixe le viewport rendu — et donc la largeur de la frame — a la valeur exacte.
      def device_metrics
        return nil if viewport[0] >= configuration.window_width_floor

        { width: viewport[0], height: viewport[1], pixelRatio: 1, touch: true }
      end

      # "current" par defaut, "baseline" avec VISUAL_BASELINE=1 : c'est ce qui permet de
      # capturer un etat de reference avant une refonte, puis de comparer apres.
      def run_kind
        ENV["VISUAL_BASELINE"] ? "baseline" : "current"
      end

      # Un viewport non par defaut ecrit dans un dossier suffixe, pour ne jamais ecraser
      # les captures de reference du projet.
      def variant_dir
        default_viewport? ? run_kind : "#{run_kind}_#{viewport.join("x")}"
      end

      def screenshots_dir
        configuration.root.join("screenshots", variant_dir)
      end

      def figma_dir
        configuration.root.join("figma", variant_dir)
      end

      # Un seul horodatage par run, appose a chaque JSON Figma. Le plugin nomme chaque frame
      # d'apres son fichier : le stamp traverse donc jusqu'au canvas, et un lot fraichement
      # importe se distingue d'un ancien au premier coup d'oeil.
      #
      # Il passe par l'environnement et non par une memoisation de classe : un projet qui
      # parallelise ses tests (workers = nombre de coeurs) donnerait sinon un stamp
      # different par worker, et la purge des versions perimees se marcherait dessus.
      def run_stamp
        ENV["VISUAL_RUN_STAMP"] ||= Time.now.strftime("%Y-%m-%d_%Hh%M")
      end

      # La tache rake, a charger par le projet hote depuis un lib/tasks/*.rake de deux
      # lignes. Pas de Railtie : une gem installee hors des groupes que Rails requiert
      # (un outil local exclu de la CI, par exemple) n'est jamais chargee au boot, donc
      # le hook rake_tasks d'un Railtie ne se declencherait pas. Un `load` explicite
      # marche dans les deux cas.
      def rake_task_path
        File.join(__dir__, "visual_tests/tasks/visual.rake")
      end

      def asset(name)
        File.join(__dir__, "visual_tests/assets", name)
      end

      # Pour les tests de la gem elle-meme.
      def reset!
        @configuration = nil
        @viewport = nil
      end
    end
  end
end
