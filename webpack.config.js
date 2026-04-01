const path = require('path');

module.exports = {
  entry: './src/index.ts',
  target: 'webworker',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
    library: { type: 'module' },
  },
  experiments: { outputModule: true },
  resolve: {
    extensions: ['.ts', '.js'],
    // No Node.js built-ins in Wasm
    fallback: { path: false, fs: false, crypto: false, buffer: false },
  },
  module: {
    rules: [
      { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
      // 讓 webpack 把 .html 當作原始字串 import
      { test: /\.html$/, type: 'asset/source' },
    ],
  },
  optimization: { minimize: false }, // componentize-js 自己會最佳化
};
