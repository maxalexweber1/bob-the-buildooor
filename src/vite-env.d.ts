/// <reference types="vite/client" />
/// <reference types="chrome" />

// crxjs: `import url from './file?script&module'` yields the emitted, web-accessible URL.
declare module '*?script&module' {
  const src: string;
  export default src;
}
declare module '*?script' {
  const src: string;
  export default src;
}
