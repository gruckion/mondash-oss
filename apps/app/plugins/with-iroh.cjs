const { withPodfileProperties, withInfoPlist, withXcodeProject } = require("expo/config-plugins");
module.exports = (config) =>
  withXcodeProject(
    withInfoPlist(
      withPodfileProperties(config, (c) => {
        c.modResults["ios.deploymentTarget"] = "17.5";
        return c;
      }),
      (c) => {
        c.modResults.NSLocalNetworkUsageDescription =
          "Connect Mondash to your paired Mac to keep your work up to date.";
        return c;
      },
    ),
    (c) => {
      const configs = c.modResults.pbxXCBuildConfigurationSection();
      for (const value of Object.values(configs))
        if (typeof value === "object" && value.buildSettings) value.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = "17.5";
      return c;
    },
  );
