Pod::Spec.new do |s|
  s.name           = 'MondashIroh'
  s.version        = '1.0.0'
  s.summary        = 'Native authenticated Mondash transport'
  s.description    = 'Demand-driven Iroh connections for the Mondash Effect API'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '17.5'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "*.swift"
  s.vendored_frameworks = "Vendor/Iroh.xcframework"
  s.frameworks = "SystemConfiguration", "Network", "Security"
  s.swift_version = "5.9"
end
