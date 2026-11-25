Pod::Spec.new do |s|
  s.name = 'LingVisualizationPreview'
  s.version = '0.0.1'
  s.summary = 'Isolated visualization preview for Ling Mobile.'
  s.license = { :type => 'MIT' }
  s.author = 'Ling Stack'
  s.homepage = 'https://github.com/ling-stack-org/ling-stack'
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
