// 讓 TypeScript 認識 webpack asset/source 匯入的 HTML 字串
declare module '*.html' {
  const content: string;
  export default content;
}
