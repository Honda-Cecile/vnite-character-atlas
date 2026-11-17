const path = require('path')
const TerserPlugin = require('terser-webpack-plugin')

/**
 * Vnite 插件主进程构建配置
 *
 * - target: node —— 插件在 Vnite 主进程（Electron main）里被 require，可用 Node 内置模块
 * - react / react-dom 直接打进 bundle：插件运行时零外部依赖，dist/index.js 即完整产物
 * - output.library.type = commonjs2 —— 产物导出 { default: plugin }，与官方脚手架 / tsc 产物形状一致
 */
module.exports = (env, argv) => {
  const isProd = (argv && argv.mode) === 'production'

  return {
    mode: isProd ? 'production' : 'development',
    target: 'node',
    entry: {
      index: path.resolve(__dirname, 'src/index.ts')
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      library: { type: 'commonjs2' },
      clean: false
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json']
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: {
            loader: 'ts-loader',
            options: { transpileOnly: false, compilerOptions: { declaration: false } }
          }
        }
      ]
    },
    // Node 内置模块交给运行时 require，不打包
    externalsPresets: { node: true },
    // electron 只能由宿主提供（渲染进程注入需要 BrowserWindow / app），不参与打包
    externals: {
      electron: 'commonjs electron'
    },
    optimization: {
      minimize: isProd,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            format: { comments: false },
            compress: { drop_debugger: true }
          },
          extractComments: false
        })
      ]
    },
    devtool: false,
    node: {
      __dirname: false,
      __filename: false
    },
    stats: {
      colors: true,
      modules: false,
      children: false
    },
    performance: { hints: false }
  }
}
