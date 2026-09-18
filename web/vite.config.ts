import { defineConfig } from 'vite';

// GitHub Pages（プロジェクトページ）へのデプロイを前提に base を固定する。
// https://soma2028.github.io/brushlink/ 配下で配信するため。
export default defineConfig({
  base: '/brushlink/',
});
