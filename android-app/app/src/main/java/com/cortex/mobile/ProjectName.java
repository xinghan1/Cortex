package com.cortex.mobile;

/** Limits project names by display units without splitting Unicode surrogate pairs. */
final class ProjectName {
    private ProjectName() {}
    static String abbreviate(String value) {
        if (value == null || value.isEmpty()) return "";
        int units = 0;
        for (int i = 0; i < value.length();) {
            int cp = value.codePointAt(i);
            int type = Character.getType(cp);
            int width = type == Character.NON_SPACING_MARK || type == Character.COMBINING_SPACING_MARK || type == Character.ENCLOSING_MARK ? 0 : cp <= 0x7f ? 1 : 2;
            if (units + width > 12) return value.substring(0, i) + "...";
            units += width;
            i += Character.charCount(cp);
        }
        return value;
    }
}
