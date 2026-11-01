package com.cortex.mobile;

public final class ModelConnectionModesTest {
    public static void main(String[] args) {
        for (int provider = 0; provider < 8; provider++) {
            String[] labels = ModelConnectionModes.labels(provider);
            if (provider == 1) {
                if (labels.length != 2 || ModelConnectionModes.selection(provider, 1) != 1) throw new AssertionError("DeepSeek login missing");
            } else if (labels.length != 1 || ModelConnectionModes.selection(provider, 1) != 0) throw new AssertionError("Account login leaked to provider " + provider);
            if (!"API Key".equals(labels[0]) || ModelConnectionModes.selection(provider, 0) != 0) throw new AssertionError("API Key missing");
        }
        System.out.println("Provider connection modes passed");
    }
}
