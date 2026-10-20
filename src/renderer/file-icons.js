'use strict';

// Bundled vector artwork. File names select a known icon; they are never used
// as SVG markup, URLs, CSS classes, or executable code.
(() => {
  const extensions = new Map();
  const register = (kind, values) => values.split(' ').forEach(value => extensions.set(value, kind));
  register('json', 'json jsonc json5');
  register('markdown', 'md markdown mdx mdown');
  register('java', 'java class jar');
  register('python', 'py pyw pyi ipynb');
  register('javascript', 'js mjs cjs');
  register('typescript', 'ts mts cts');
  register('react', 'jsx');
  register('react-typescript', 'tsx');
  register('html', 'html htm xhtml');
  register('css', 'css scss sass less');
  register('vue', 'vue');
  register('svelte', 'svelte');
  register('xml', 'xml xsd xsl xslt');
  register('yaml', 'yaml yml');
  register('config', 'toml ini cfg conf config properties');
  register('image', 'png jpg jpeg webp gif bmp ico avif tif tiff heic');
  register('svg', 'svg');
  register('text', 'txt text log rst');
  register('c', 'c h');
  register('cpp', 'cpp cc cxx hpp hh hxx');
  register('csharp', 'cs csx');
  register('kotlin', 'kt kts');
  register('go', 'go');
  register('rust', 'rs');
  register('ruby', 'rb erb');
  register('php', 'php phtml');
  register('swift', 'swift');
  register('dart', 'dart');
  register('shell', 'sh bash zsh fish ps1 psm1 psd1 bat cmd');
  register('database', 'sql sqlite sqlite3 db');
  register('table', 'csv tsv xls xlsx ods');
  register('document', 'doc docx odt rtf');
  register('presentation', 'ppt pptx odp');
  register('pdf', 'pdf');
  register('archive', 'zip 7z rar tar gz bz2 xz tgz');
  register('audio', 'mp3 wav flac ogg m4a aac');
  register('video', 'mp4 mov webm avi mkv m4v');
  register('lock', 'lock');

  const names = new Map([
    ['readme', 'markdown'], ['license', 'license'], ['licence', 'license'], ['copying', 'license'],
    ['dockerfile', 'docker'], ['containerfile', 'docker'], ['makefile', 'config'],
    ['cmakelists.txt', 'config'], ['.editorconfig', 'config'], ['.npmrc', 'config'],
    ['.prettierrc', 'config'], ['.eslintrc', 'config'], ['.gitignore', 'git'],
    ['.gitattributes', 'git'], ['.gitmodules', 'git'],
  ]);

  function kindForName(name, type = 'file') {
    if (type === 'directory') return 'folder';
    const leaf = String(name || '').split(/[\\/]/u).pop().toLowerCase();
    if (names.has(leaf)) return names.get(leaf);
    if (/^(?:dockerfile|containerfile)\./u.test(leaf)) return 'docker';
    if (/^(?:license|licence|copying)\./u.test(leaf)) return 'license';
    const dot = leaf.lastIndexOf('.');
    return dot > 0 ? extensions.get(leaf.slice(dot + 1)) || 'file' : 'file';
  }

  const label = (text, size = 10) => `<rect x="2.5" y="3" width="19" height="18" rx="3" fill="currentColor" opacity=".14" stroke="none"/><text x="12" y="16" text-anchor="middle" font-size="${size}" font-weight="700" fill="currentColor" stroke="none">${text}</text>`;
  const icons = {
    file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z M14 3v5h5 M8 12h8 M8 16h6"/>',
    folder: '<path class="file-folder-closed" d="M3 6h6l2 2h10v11H3V6Z"/><path class="file-folder-open" d="M3 11V6h6l2 2h9v3 M3 11h19l-3 8H4l-1-8Z"/>',
    json: '<path stroke-width="2" d="M9 3H7a2 2 0 0 0-2 2v3c0 2-1 3-3 4 2 1 3 2 3 4v3a2 2 0 0 0 2 2h2 M15 3h2a2 2 0 0 1 2 2v3c0 2 1 3 3 4-2 1-3 2-3 4v3a2 2 0 0 1-2 2h-2"/>',
    markdown: '<rect x="2" y="5" width="20" height="14" rx="2"/><path stroke-width="1.8" d="M5 15V9l3 4 3-4v6 M17 9v6 M14 12l3 3 3-3"/>',
    java: '<path d="M5 11h12v3a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5v-3Z M17 12h2a2 2 0 0 1 0 4h-2 M4 21h16 M10 8c-4-3 4-3 0-6 M14 8c-3-2 3-2 1-5"/>',
    python: '<path fill="#80b9ed" stroke="none" d="M12 2c-5 0-5 2-5 5v2h7v1H5c-4 0-4 8 0 8h1v-3c0-3 2-4 5-4h5c3 0 3-2 3-4V6c0-3-3-4-7-4Z"/><path fill="#f1cd70" stroke="none" d="M12 22c5 0 5-2 5-5v-2h-7v-1h9c4 0 4-8 0-8h-1v3c0 3-2 4-5 4H8c-3 0-3 2-3 4v1c0 3 3 4 7 4Z"/><circle cx="10" cy="5" r="1" fill="#172b46" stroke="none"/><circle cx="14" cy="19" r="1" fill="#594317" stroke="none"/>',
    javascript: label('JS'),
    typescript: label('TS'),
    react: '<ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    html: '<path stroke-width="2" d="m8 6-6 6 6 6 M16 6l6 6-6 6 M14 4l-4 16"/>',
    css: '<path d="M5 3h14l-1.5 16L12 21l-5.5-2L5 3Z M9 8h7l-.5 4H10l.3 4 2 .8 2-.8"/>',
    vue: '<path d="m2 5 10 16L22 5h-5l-5 8-5-8H2Z" fill="currentColor" opacity=".18"/><path stroke-width="2" d="m2 5 10 16L22 5 M7 5l5 8 5-8"/>',
    svelte: label('S', 13),
    xml: '<path stroke-width="1.8" d="m7 7-5 5 5 5 M17 7l5 5-5 5 M10 5l4 14 M14 5l-4 14"/>',
    yaml: label('YML', 8),
    config: '<path d="M4 6h16 M4 12h16 M4 18h16"/><rect x="7" y="4" width="3" height="4" rx="1" fill="currentColor"/><rect x="14" y="10" width="3" height="4" rx="1" fill="currentColor"/><rect x="8" y="16" width="3" height="4" rx="1" fill="currentColor"/>',
    image: '<path d="M6 3H2v14 M6 7h16v14H6V7Z"/><circle cx="17" cy="11" r="1.5" fill="currentColor" stroke="none"/><path d="m6 18 5-5 5 6 3-3 3 3"/>',
    svg: '<rect x="3" y="3" width="4" height="4" rx=".5"/><rect x="17" y="3" width="4" height="4" rx=".5"/><rect x="10" y="17" width="4" height="4" rx=".5"/><path d="M7 5h10 M5 7c0 6 3 9 7 10 4-1 7-4 7-10"/>',
    text: '<path d="M5 3h14v18H5V3Z M8 8h8 M8 12h8 M8 16h5"/>',
    c: label('C', 13),
    cpp: label('C++', 8),
    csharp: label('C#', 10),
    kotlin: label('K', 13),
    go: label('GO', 10),
    rust: label('R', 13),
    ruby: '<path d="m3 8 4-5h10l4 5-9 13L3 8Z M3 8h18 M7 3l5 18L17 3"/>',
    php: label('php', 9),
    swift: '<path d="m3 5 12 9-6-11 11 12 1 6-5-3-6 1-7-5 6 1-6-10Z" fill="currentColor" opacity=".85" stroke="none"/>',
    dart: label('D', 13),
    shell: '<rect x="2" y="4" width="20" height="16" rx="2"/><path stroke-width="1.8" d="m6 8 4 4-4 4 M13 16h5"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5 M4 12c0 4 16 4 16 0"/>',
    table: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18 M3 15h18 M9 3v18"/>',
    document: label('W', 12),
    presentation: label('P', 12),
    pdf: label('PDF', 8),
    archive: '<path d="M14 3H5v18h14V8l-5-5Z M14 3v5h5 M10 3v2h2v2h-2v2h2v2h-2v3"/><rect x="9" y="14" width="4" height="4" rx="1"/>',
    audio: '<path d="M9 17V5l11-2v12 M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/>',
    video: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m10 8 6 4-6 4V8Z" fill="currentColor" stroke="none"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4 M12 14v3"/>',
    license: '<path d="M5 3h14v13H5V3Z M8 7h8 M8 10h5 M8 16v6l4-3 4 3v-6"/>',
    docker: '<path d="M2 13h17c0 5-5 8-10 8-4 0-7-3-7-8Z M19 13l3-3 M4 9h4v4H4V9Z M9 9h4v4H9V9Z M14 9h4v4h-4V9Z M9 4h4v4H9V4Z"/>',
    git: '<circle cx="7" cy="5" r="2"/><circle cx="17" cy="6" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10 M17 8v2a4 4 0 0 1-4 4H7"/>',
  };
  icons['react-typescript'] = icons.react;

  function create(name, type = 'file') {
    const kind = kindForName(name, type);
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.dataset.kind = kind;
    icon.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = icons[kind];
    icon.append(svg);
    return icon;
  }

  window.ForgeFileIcons = Object.freeze({ create, kindForName });
})();
