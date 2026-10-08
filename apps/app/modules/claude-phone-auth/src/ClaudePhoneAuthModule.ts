import { NativeModule, requireOptionalNativeModule } from "expo";

declare class ClaudePhoneAuthModule extends NativeModule {
  signIn(browserUrl: string, callbackEndpoint: string, oauthUrl: string): Promise<boolean>;
}
export default requireOptionalNativeModule<ClaudePhoneAuthModule>("ClaudePhoneAuth");
