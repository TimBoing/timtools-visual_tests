# frozen_string_literal: true

namespace :test do
  desc "Lance les tests visuels (captures PNG / export Figma). TEST=chemin pour cibler."
  task :visual do
    # Pose l'horodatage du run ici : les tests peuvent tourner en plusieurs process, et
    # chacun heriterait sinon d'un stamp different.
    ENV["VISUAL_RUN_STAMP"] ||= Time.now.strftime("%Y-%m-%d_%Hh%M")
    path = ENV["TEST"] || "test/visual"
    sh "bin/rails", "test", path
  end
end
