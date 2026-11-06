# frozen_string_literal: true

require "fileutils"

module Timtools
  module VisualTests
    # A inclure dans la classe de base des tests visuels du projet hote
  # (`include Timtools::VisualTests::Capture`). Suppose un contexte
    # Capybara + Selenium (`page`, `page.driver.browser`) : c'est le driver du projet qui est
    # utilise, la gem n'en declare aucun.
    module Capture
      # Capture l'etat courant sous `name`. SCREENSHOT_FORMAT choisit la ou les sorties :
      #   "png" (defaut) | "json" (Figma seul) | "both".
      #
      # En "both", le PNG passe en premier : figma_export mute le DOM (les <i class="fa-*">
      # deviennent des <img> rasterises), donc un PNG pris apres ne montrerait plus la page
      # telle que l'utilisateur la voit.
      def screenshot(name, full: true)
        format = ENV.fetch("SCREENSHOT_FORMAT", "png")
        save_png(name, full: full) if %w[png both].include?(format)
        figma_export(name) if %w[json both].include?(format)
      end

      # full: true (defaut) etire la fenetre a toute la page scrollable ; full: false garde
      # le viewport (pour une modale, un toast, tout ce qui est ancre a l'ecran).
      def save_png(name, full: true)
        width, height = VisualTests.viewport
        if full
          page_height = page.evaluate_script(
            "Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)"
          ).to_i
          visual_resize_window(width, [page_height, height].max)
        else
          visual_resize_window(width, height)
        end

        path = VisualTests.screenshots_dir.join("#{name}.png")
        FileUtils.mkdir_p(path.dirname)
        page.save_screenshot(path.to_s)
        puts "📸 #{visual_relative(path)}"
        path
      end

      # Exporte le DOM rendu (par defaut la page entiere) en arbre de calques Figma (JSON)
      # pour le plugin "layers-importer". Injecte le bundle html-to-figma vendore puis notre
      # script d'enrichissement, et appelle window.__figmaCapture.
      def figma_export(name, selector: "body")
        visual_inject_capture_scripts

        page.driver.browser.manage.timeouts.script = 60
        result = page.driver.browser.execute_async_script(<<~JS, selector)
          const done = arguments[arguments.length - 1];
          if (typeof window.__figmaCapture !== "function" || typeof window.__htmlToFigma !== "function") {
            done({ ok: false, error: "capture scripts not loaded" }); return;
          }
          window.__figmaCapture(window.__htmlToFigma, arguments[0])
            .then((json) => done({ ok: true, json: json }))
            .catch((err) => done({ ok: false, error: String((err && err.stack) || err) }));
        JS
        raise "htmlToFigma failed: #{result['error']}" unless result["ok"]

        path = VisualTests.figma_dir.join("#{name}_#{VisualTests.run_stamp}.json")
        FileUtils.mkdir_p(path.dirname)
        # Une seule version par ecran dans le dossier : le stamp vit dans le nom de fichier
        # (et se retrouve dans le nom de la frame Figma), mais relancer un seul test ne doit
        # pas laisser des copies perimees qui seraient reimportees avec le lot.
        Dir.glob(VisualTests.figma_dir.join("#{name}_????-??-??_??h??.json")).each { |stale| File.delete(stale) }
        File.write(path, result["json"])
        puts "🎨 #{visual_relative(path)} (#{File.size(path)} bytes)"
        path
      end

      # Fige toute animation et transition CSS de la page. Indispensable pour capturer ce qui
      # s'efface tout seul — un toast, un flash qui disparait apres quelques secondes : entre
      # la mesure de la hauteur de page et le declenchement de la capture, l'element visé a
      # sinon toutes les chances d'avoir deja commence a partir, et de facon non deterministe.
      #
      # Injecte une feuille dans la page plutot que du CSS de test dans l'application : ce
      # qu'on veut documenter est un placement et un habillage, pas une entree en scene.
      def freeze_animations!
        page.execute_script(<<~JS)
          (function () {
            if (document.getElementById("__timtools_visual_freeze")) return;
            const style = document.createElement("style");
            style.id = "__timtools_visual_freeze";
            style.textContent = `*, *::before, *::after {
              animation-play-state: paused !important;
              animation-delay: 0s !important;
              animation-duration: 0s !important;
              animation-fill-mode: none !important;
              transition: none !important;
            }`;
            document.head.appendChild(style);
          })();
        JS
      end

      # Vrai quand le run tourne sur un viewport autre que celui de reference du projet
      # (VISUAL_VIEWPORT). Les tests dont l'interaction differe s'y branchent.
      def mobile?
        !VisualTests.default_viewport?
      end

      private

      def visual_inject_capture_scripts
        page.execute_script(<<~JS)
          #{File.read(VisualTests.asset("html_to_figma.js"))}
          ;window.__htmlToFigma = (typeof htmlToFigma === "function") ? htmlToFigma : (htmlToFigma && htmlToFigma.htmlToFigma);
        JS
        page.execute_script(File.read(VisualTests.asset("figma_capture.js")))
      end

      def visual_resize_window(width, height)
        page.driver.browser.manage.window.resize_to(width, height)
      end

      def visual_relative(path)
        defined?(Rails) && Rails.root ? path.relative_path_from(Rails.root) : path
      end
    end
  end
end
