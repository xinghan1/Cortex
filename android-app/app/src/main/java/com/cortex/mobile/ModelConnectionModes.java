package com.cortex.mobile;

/** Available connection methods must match the selected provider. */
final class ModelConnectionModes {
    private ModelConnectionModes() {}
    static String[] labels(int provider) {
        return provider == 1 ? new String[]{"API Key", "账号登录（DeepSeek）"} : new String[]{"API Key"};
    }
    static int selection(int provider, int requested) { return provider == 1 && requested == 1 ? 1 : 0; }
}
