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
    fallback: { path: false, fs: false, crypto: false, buffer: false },
  },
  module: {
    rules: [
      { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
      { test: /\.html$/, type: 'asset/source' },
    ],
  },
  optimization: { minimize: false },
};
