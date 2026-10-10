const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// Single source of truth for feature switches. The bundle imports the same
// file, so a flag cannot be on in the app and off in the HTML.
const { AI_ASSISTANT_ENABLED } = require('./feature-flags.cjs');

// Static pages for crawlers that do not run JavaScript (scripts/static-pages.mjs).
// The module is ESM, so it is imported lazily; every caller below is async.
// Building once per compilation keeps the index in index.html and the emitted
// pages from ever describing two different catalogues.
const staticPagesFor = new WeakMap();
const staticPages = (compilation) => {
  if (!staticPagesFor.has(compilation)) {
    staticPagesFor.set(
      compilation,
      import('./scripts/static-pages.mjs').then((mod) => ({
        mod,
        out: mod.buildStaticPages(mod.loadInputs()),
      })),
    );
  }
  return staticPagesFor.get(compilation);
};

/** Emits one page per extension plus sitemap.xml next to the bundle. */
class StaticPagesPlugin {
  apply(compiler) {
    const { RawSource } = compiler.webpack.sources;
    compiler.hooks.thisCompilation.tap('StaticPagesPlugin', (compilation) => {
      compilation.hooks.processAssets.tapPromise(
        {
          name: 'StaticPagesPlugin',
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        async () => {
          const { mod, out } = await staticPages(compilation);
          // Rebuild in dev when the catalogue changes, as for any import.
          for (const file of mod.INPUT_FILES) compilation.fileDependencies.add(file);
          for (const page of out.pages) compilation.emitAsset(page.path, new RawSource(page.html));
          compilation.emitAsset('sitemap.xml', new RawSource(out.sitemap));
        },
      );
    });
  }
}

/**
 * Exported as a function so one config serves both jobs. `npm run build` passes
 * no --mode and falls through to production, producing exactly the bundle it
 * produced before. `npm run dev` passes --mode development and additionally
 * gets source maps and a live-reloading server.
 *
 * Source maps stay off in production on purpose: the bundle is minified and
 * published to GitHub Pages, where emitting maps roughly doubles the payload
 * for no benefit to visitors.
 */
module.exports = (env, argv = {}) => {
  const isDev = argv.mode === 'development';

  return {
    mode: argv.mode || 'production',
    entry: './src/main.jsx',
    output: {
      filename: 'bundle.js',
      path: path.resolve(__dirname, 'dist'),
      // Webpack 5 leaves its output directory alone by default, so anything a
      // previous build emitted survives forever. A local dist/ had accumulated
      // a 280 KB PNG that nothing referenced. It matters more now that the
      // build emits code-split chunks, since stale chunks would linger and be
      // published by a manual deploy.
      clean: true,
    },
    // eval-source-map keeps rebuilds fast while still pointing at the original JSX.
    devtool: isDev ? 'eval-source-map' : false,
    devServer: {
      port: 8080,
      hot: true,
      open: false,
      // Serving dist/ keeps the dev and production layouts identical rather
      // than introducing a second one that can drift.
      static: { directory: path.resolve(__dirname, 'dist') },
      client: { overlay: { errors: true, warnings: false } },
    },
    module: {
      rules: [
        {
          test: /\.jsx?$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              // Classic transform, stated explicitly: JSX compiles to
              // React.createElement, so every .jsx file keeps React in scope.
              // Babel 8 changed the preset's default to the automatic runtime,
              // so leaving this out would silently switch transforms.
              presets: [['@babel/preset-react', { runtime: 'classic' }]],
            },
          },
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader', 'postcss-loader'],
        },
        // PNG assets: emitted to dist/ and resolved to their URL at runtime.
        // No npm dep needed — webpack 5 asset modules are built in.
        {
          test: /\.png$/,
          type: 'asset/resource',
        },
      ],
    },
    resolve: {
      extensions: ['.js', '.jsx'],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './public/index.html',
        filename: 'index.html',
        // Read by the guard around the kapa.ai widget in the template. The
        // function form re-states the plugin's own parameters because passing
        // any templateParameters replaces them wholesale, and `inject` is
        // resolved from them: drop htmlWebpackPlugin.files and the bundle
        // script is never added to the page.
        templateParameters: async (compilation, assets, assetTags, options) => ({
          compilation,
          webpackConfig: compilation.options,
          htmlWebpackPlugin: { tags: assetTags, files: assets, options },
          aiAssistantEnabled: AI_ASSISTANT_ENABLED,
          staticIndexHtml: (await staticPages(compilation)).out.indexHtml,
        }),
      }),
      new StaticPagesPlugin(),
    ],
  };
};
