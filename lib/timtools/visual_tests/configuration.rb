# frozen_string_literal: true

module Timtools
  module VisualTests
    # Reglages du projet hote. Tout a un defaut utilisable ; un projet n'a normalement
    # que `root` et `default_viewport` a poser.
    class Configuration
      # Ou atterrissent les captures. `screenshots/` et `figma/` sont crees dessous.
      attr_accessor :root

      # Viewport utilise quand VISUAL_VIEWPORT n'est pas donne. Le viewport "de reference"
      # d'un projet : c'est lui qui ecrit dans le dossier non suffixe.
      attr_accessor :default_viewport

      # Largeur en dessous de laquelle Chrome refuse de retrecir la fenetre et clampe la
      # capture : on bascule alors sur l'emulation de device. 500 est le plancher observe.
      attr_accessor :window_width_floor

      def initialize
        @default_viewport = [1512, 982]
        @window_width_floor = 500
      end

      def root
        @root || raise(<<~MSG)
          Timtools::VisualTests n'est pas configure. Dans le projet hote :

            VisualTests.configure do |config|
              config.root = Rails.root.join("test/visual")
              config.default_viewport = [390, 844]
            end
        MSG
      end
    end
  end
end
