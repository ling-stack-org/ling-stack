Pod::Spec.new do |s|
  s.name           = 'LingSecureDeviceKey'
  s.version        = '0.0.1'
  s.summary        = 'Non-exportable P-256 device signing for Ling Mobile.'
  s.description    = 'Expo local module backed by Secure Enclave on release-capable iOS devices.'
  s.license        = { :type => 'MIT' }
  s.author         = { 'Ling Stack' => 'dev@localhost' }
  s.homepage       = 'https://github.com/earendil-works/ling-stack'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end
