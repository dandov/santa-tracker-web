#!/usr/bin/env node

/**
 * @fileoverview Builds Santa Tracker for release to production.
 */

const chalk = require('chalk');
const fsp = require('./build/fsp.js');
const globAll = require('./build/glob-all.js');
const i18n = require('./build/i18n.js');
const importUtils = require('./build/import-utils.js');
const log = require('fancy-log');
const path = require('path');
const releaseHtml = require('./build/release-html.js');
const santaVfs = require('./santa-vfs.js');
const modernBuilder = require('./build/modern-builder.js');
const sourceMagic = require('./build/source-magic.js');
const {Writer} = require('./build/writer.js');

// Generates a version like `vYYYYMMDDHHMM`, in UTC time.
const DEFAULT_STATIC_VERSION = 'v' + (new Date).toISOString().replace(/[^\d]/g, '').substr(0, 12);
const DEFAULT_LANG = 'en';  // write these files to top-level

const yargs = require('yargs')
    .strict()
    .epilogue('https://github.com/google/santa-tracker-web')
    .option('build', {
      alias: 'b',
      type: 'string',
      default: DEFAULT_STATIC_VERSION,
      describe: 'Production build tag',
    })
    .options('transpile', {
      type: 'boolean',
      default: true,
      describe: 'Transpile for ES5 browsers (slow)',
    })
    .option('default-only', {
      alias: 'o',
      type: 'boolean',
      default: false,
      describe: 'Only generate top-level language',
    })
    .option('baseurl', {
      type: 'string',
      default: 'https://maps.gstatic.com/mapfiles/santatracker/',
      describe: 'URL to static content',
    })
    .option('prod', {
      type: 'boolean',
      default: true,
      describe: 'Whether to build prod and related static entrypoint',
    })
    .option('scene', {
      type: 'array',
      default: [],
      describe: 'Limit static build to selected scenes',
    })
    .argv;

const assetsToCopy = [
  'static/audio/*',
  'static/img/**/*',
  'static/third_party/**/LICENSE*',
  'static/third_party/lib/klang/**',
  'static/scenes/**/models/**',
  'static/scenes/**/img/**',

  // Explicitly include Web Components polyfill bundles, as they're injected at runtime rather than
  // being directly referenced by a `<script>`.
  'static/node_modules/@webcomponents/webcomponentsjs/bundles/*.js',

  'prod/**',
  '!prod/**/*.html',
  '!prod/**/*.js',
  '!prod/**/*.json',
];

// nb. matches config in serve.js
const config = {
  staticScope: `${yargs.baseurl}${yargs.build}/`,
  version: yargs.build,
};

const vfs = santaVfs(config.staticScope, {config});

const releaseWriter = new Writer({
  loader: vfs,
  allowed: ['static', 'prod'],
  target: 'dist',
});

function prodPathForLang(lang) {
  if (lang === DEFAULT_LANG) {
    return 'prod';
  }
  return `prod/intl/${lang}_ALL`
}

function rewritePathForLang(id, lang) {
  if (!lang) {
    return id;
  }
  const p = path.parse(id);
  return path.join(p.dir, `${p.name}_${lang}${p.ext}`);
}

async function release() {
  log(`Building Santa Tracker ${chalk.red(yargs.build)}...`);

  if (await fsp.exists('dist')) {
    log(`Removing previous release...`);
    await fsp.unlinkAll('dist');
  }

  // "_static" contains our actual static root. Create the "static" symlink so that we can reuse
  // the top-level layout when we blit out generated files, so that static resources are correctly
  // placed within the staticRoot.
  const staticRoot = (new URL(config.staticScope)).pathname;
  await fsp.mkdirp(path.join('dist/_static', staticRoot));
  await fsp.mkdirp('dist/prod');
  await fsp.symlink(path.join('_static', staticRoot), 'dist/static');
 
  // Display the static URL plus the root (in a different color).
  if (!config.staticScope.endsWith(staticRoot)) {
    throw new TypeError(`invalid static resolution: ${config.staticScope} vs ${staticRoot}`)
  }
  log(`Static at ${chalk.green(config.staticScope)}`);

  // Find the list of languages by reading `_messages`.
  const missingMessages = {};
  const langs = i18n.all((lang, msgid) => {
    if (!(msgid in missingMessages)) {
      missingMessages[msgid] = new Set();
    }
    missingMessages[msgid].add(lang);
  });
  if (!(DEFAULT_LANG in langs)) {
    throw new Error(`default lang '${DEFAULT_LANG}' not found in _messages`);
  }
  if (yargs.defaultOnly) {
    Object.keys(langs).forEach((otherLang) => {
      if (otherLang !== DEFAULT_LANG) {
        delete langs[otherLang];
      }
    });
  }
  log(`Building ${chalk.cyan(Object.keys(langs).length)} languages`);

  // Release prod entrypoints.
  if (yargs.prod) {
    await releaseProd(langs);
  }

  // Shared resources needed by prod build.
  const staticEntrypoints = {};
  const requiredScriptSources = new Set();

  // Santa Tracker builds static by finding HTML entry points and parsing/rewriting each file,
  // including traversing their dependencies like CSS and JS. It doesn't specifically compile CSS 
  // or JS on its own, it must be included by one of our HTML entry points.

  const htmlFiles = [];
  if (yargs.scene.length) {
    htmlFiles.push(...yargs.scene.map((scene) => path.join('static/scenes', scene, 'index.html')));
  } else {
    htmlFiles.push(...globAll('static/scenes/*/index.html', '!static/scenes/poseboogie/**/index.html'));
  }
  if (!htmlFiles.length) {
    throw new Error('no entrypoints matched');
  }

  log(`Processing ${chalk.cyan(htmlFiles.length)} entrypoint HTML files...`);

  const htmlDocuments = new Map();
  for (const htmlFile of htmlFiles) {
    const dom = await releaseHtml.dom(htmlFile);
    const document = dom.window.document;

    const dir = path.dirname(htmlFile);

    // Find assets that are going to be inlined.
    const styleLinks = [...document.querySelectorAll('link[rel="stylesheet"]')];
    const allScripts = Array.from(document.querySelectorAll('script')).filter((scriptNode) => {
      return !(scriptNode.src && importUtils.isUrl(scriptNode.src));
    });

    // Inline all local referenced styles.
    for (const styleLink of styleLinks) {
      if (importUtils.isUrl(styleLink.href)) {
        continue;  // TODO(samthor): mostly Google Fonts, but could be worth validating
      }
      const target = path.join(dir, styleLink.href);
      const out = await vfs(target) || await fsp.readFile(target, 'utf-8');
      const inlineStyleTag = document.createElement('style');
      inlineStyleTag.innerHTML = 'code' in out ? out.code : out;
      styleLink.replaceWith(inlineStyleTag);
    }

    // Find non-module scripts, as they contain dependencies like jQuery, THREE.js etc. These are
    // catalogued and then included in the static output.
    allScripts
        .filter((s) => s.src && (!s.type || s.type === 'text/javascript'))
        .map((s) => path.join(dir, s.src))
        .forEach((src) => requiredScriptSources.add(src));

    // Find all module scripts, so that all JS entrypoints can be catalogued and built together.
    let count = 0;
    const moduleScriptNodes = allScripts.filter((s) => s.type === 'module');
    for (const scriptNode of moduleScriptNodes) {
      let code = scriptNode.textContent;

      // If it's an external script, pretend that we have local code that imports it.
      if (scriptNode.src) {
        if (code) {
          throw new TypeError(`got invalid <script>: both code and src`);
        }
        code = importUtils.staticImport(scriptNode.src);
      }
      const id = `${htmlFile}#${count++}`;
      staticEntrypoints[id] = {scriptNode, code};

      // Clear scriptNode.
      scriptNode.textContent = `/* ${id} */`;
      scriptNode.removeAttribute('src');
    }

    htmlDocuments.set(htmlFile, {dom, moduleScriptNodes});
  }

  // Optionally include entrypoints (needed for prod).
  if (yargs.prod) {
    const prodScripts = globAll('static/entrypoint.js');
    for (const id of prodScripts) {
      staticEntrypoints[`${id}#`] = {
        scriptNode: null,
        code: importUtils.staticImport(path.basename(id)),
      };
    }

    // Special-case building the loader, which has no translations and magic.
    const loaderEntrypoints = {
      'prod/loader.js': {code: await fsp.readFile('prod/loader.js', 'utf-8')},
    };
    const bundles = await modernBuilder(loaderEntrypoints, {
      loader: vfs,
      workDir: 'prod',
    });
    if (bundles.length !== 1) {
      throw new TypeError(`could not compile single loader bundle, got ${bundles.length}`);
    }
    releaseWriter.file('prod/loader.js', bundles[0].code);
    log(`Built prod loader`);
  }

  log(`Found ${chalk.cyan(requiredScriptSources.size)} required script sources`);
  log(`Found ${chalk.cyan(Object.keys(staticEntrypoints).length)} entrypoints, merging...`);

  const bundles = await modernBuilder(staticEntrypoints, {
    loader: vfs,
    external(id) {
      if (id === 'static/src/magic.js') {
        return '__magic';
      }
    },
    workDir: 'static',
    metaUrlScope: config.staticScope,
  });
  log(`Generated ${chalk.cyan(bundles.length)} static bundles via Rollup, rewriting...`);

  const annotatedBundles = {};
  const builder = sourceMagic({
    magicImport(importName) {
      return importName === '__magic';
    },
    taggedTemplate(lang, name, key) {
      switch (name) {
        case '_msg':
          const messages = langs[lang];
          return messages(key);

        case '_static':
          return config.staticScope + key;

        default:
          throw new TypeError(`unsupported magic: ${name}`);
      }
    },
    rewriteImport(lang, id) {
      const bundle = annotatedBundles[id];
      if (bundle && bundle.i18n) {
        if (!lang) {
          throw new TypeError(`Got bundle without lang request`);
        }
        return rewritePathForLang(id, lang);
      }
    },
  });

  // Prepare rewriters for all scripts, and determine whether they need i18n at all.
  const scriptNodeToBundle = new Map();
  for (const bundle of bundles) {
    if (bundle.isDynamicEntry) {
      // Santa Tracker doesn't handle these.
      throw new TypeError(`dynamic entry unsupported: ${bundle.fileName}`);
    } else if (bundle.facadeModuleId && path.dirname(bundle.fileName) !== path.dirname(bundle.facadeModuleId)) {
      // Sanity-check expectations.
      throw new TypeError(`unexpected divergence of fileName ${bundle.fileName} vs facadeModuleId ${bundle.facadeModuleId}`);
    }

    const {seen, rewrite} = await builder(bundle.code, bundle.fileName);
    const entrypoint = staticEntrypoints[bundle.facadeModuleId];

    annotatedBundles[bundle.fileName] = {
      entrypoint: entrypoint || null,
      inline: entrypoint && entrypoint.scriptNode || false,
      i18n: seen.has('_msg'),
      rewrite,
      imports: bundle.imports.filter((x) => x !== '__magic'),
    };

    if (entrypoint && entrypoint.scriptNode) {
      scriptNodeToBundle.set(entrypoint.scriptNode, annotatedBundles[bundle.fileName]);
    }
  }

  // Determine the transitive properties of each bundle: their import tree (for preload) and if
  // they must be re-compiled for i18n even _without_ messages.
  let rewrittenSources = 0;
  for (const fileName in annotatedBundles) {
    const b = annotatedBundles[fileName];

    const work = new Set(b.imports);
    for (const dep of work) {
      const o = annotatedBundles[dep];
      if (o.i18n) {
        b.i18n = true;
      }
      o.imports.forEach((i) => work.add(i));
    }
    b.allImports = Array.from(work);

    const attrs = [];
    b.entrypoint && attrs.push('entrypoint');
    b.i18n && attrs.push('i18n');
    const prettyAttrs = attrs.map((attr) => chalk.magenta(attr)).join(',');
    log(`Rewriting bundle ${chalk.yellow(fileName)} [${prettyAttrs}]...`);

    const sanitizedFile = fileName.split('#')[0];

    if (b.i18n) {
      // Rewrite this module for each language.
      b.code = {};
      for (const lang in langs) {
        b.code[lang] = b.rewrite(lang);
        ++rewrittenSources;

        if (b.inline) {
          continue;
        }

        releaseWriter.file(rewritePathForLang(sanitizedFile, lang), b.code[lang]);
      }

      continue;
    }

    // There's no i18n or transitive language content.
    b.code = b.rewrite(null);
    ++rewrittenSources;

    if (!b.inline) {
      releaseWriter.file(sanitizedFile, b.code);
    }
  }

  log(`Rewrote ${chalk.cyan(rewrittenSources)} source files`);

  // Now, rewrite all static HTML files for every language.
  for (const [fileName, {dom, moduleScriptNodes}] of htmlDocuments) {
    const applyLang = releaseHtml.buildApplyLang(dom);

    for (const lang in langs) {
      for (const scriptNode of moduleScriptNodes) {
        // TODO(samthor): add `<link rel="modulepreload" href="..." />`, fix for i18n deps
        const bundle = scriptNodeToBundle.get(scriptNode);
        if (typeof bundle.code === 'string') {
          scriptNode.textContent = bundle.code;
        } else {
          scriptNode.textContent = bundle.code[lang];
        }
      }

      const serialized = applyLang(langs[lang]);
      releaseWriter.file(rewritePathForLang(fileName, lang), serialized);
    }
  }

  // Copy everything else (but filter prod assets if not requested).
  const otherAssets = globAll(...assetsToCopy).concat(...requiredScriptSources)
  const limitedOtherAssets = yargs.prod ? otherAssets : otherAssets.filter((f) => !f.startsWith('prod/'));
  const otherAssetsCount = releaseWriter.all(limitedOtherAssets);
  log(`Releasing ${chalk.cyan(otherAssetsCount)} static assets`);

  // Display information about missing messages.
  const missingMessagesKeys = Object.keys(missingMessages);
  if (missingMessagesKeys.length) {
    log(`Missing ${chalk.red(missingMessagesKeys.length)} messages:`);
    missingMessagesKeys.forEach((msgid) => {
      const missingLangs = missingMessages[msgid];
      const ratio = (missingLangs.size / Object.keys(langs).length * 100).toFixed() + '%';
      const rest = (missingLangs.size <= 10) ? `[${[...missingLangs]}]` : '';
      console.info(chalk.yellow(msgid), 'for', chalk.red(ratio), 'of langs', rest);
    });
  }

  // Wait for writing to complete and announce success! \o/
  const count = await releaseWriter.wait();
  log(`Done! Written ${chalk.cyan(count)} files`);
}

async function releaseProd(langs) {
  // Fanout these scenes in prod.
  // TODO(samthor): This list should be bigger.
  const prodPages = (await fsp.readdir('./static/scenes')).filter((cand) => cand.match(/^[a-z  ]+/));
  log(`Found ${chalk.cyan(Object.keys(prodPages).length)} prod pages`);

  // Match non-index.html prod pages, like cast, error etc.
  let prodHtmlCount = 0;
  const prodOtherHtml = globAll('prod/*.html', '!prod/index.html');
  for (const htmlFile of prodOtherHtml) {
    const documentForLang = await releaseHtml.load(htmlFile);

    const tail = path.basename(htmlFile);
    for (const lang in langs) {
      const target = path.join(prodPathForLang(lang), tail);
      releaseWriter.file(target,  documentForLang(langs[lang]));
      ++prodHtmlCount;
    }
  }

  // Fanout prod index.html to all scenes and langs.
  for (const page of prodPages) {
    // TODO(samthor): This loads and minifies the prod HTML ~scenes times, but it is destructive.
    const documentForLang = await releaseHtml.load('prod/index.html', async (document) => {
      const head = document.head;

      const image = `prod/images/og/${page}.png`;
      if (await fsp.exists(image)) {
        const url = `/images/og/${page}.png`;
        const all = [
          '[property="og:image"]',
          '[name="twitter:image"]',
        ];
        releaseHtml.applyAttributeToAll(head, all, 'content', url);
      }

      // const msgid = msgidForScene(page, prodScenes[page]);
      const msgid = 'santatracker';  // FIXME: no msgid
      const all = ['title', '[property="og:title"]', '[name="twitter:title"]'];
      releaseHtml.applyAttributeToAll(head, all, 'msgid', msgid);
    });

    for (const lang in langs) {
      const filename = page ? `${page}.html` : 'index.html';
      const target = path.join(prodPathForLang(lang), filename);
      releaseWriter.file(target, documentForLang(langs[lang]));
      ++prodHtmlCount;
    }
  }

  log(`Generated ${chalk.cyan(prodHtmlCount)} prod pages`);

  // Generate manifest.json for every language.
  const manifest = require('./prod/manifest.json');
  for (const lang in langs) {
    const messages = langs[lang];
    manifest['name'] = messages('santatracker');
    manifest['short_name'] = messages('santa-app');
    const target = path.join(prodPathForLang(lang), 'manifest.json');
    releaseWriter.file(target, JSON.stringify(manifest));
  }

  log(`Generated ${chalk.cyan(Object.keys(langs).length)} manifest files`);
}

release().catch((err) => {
  console.warn(err);
  process.exit(1);
});
