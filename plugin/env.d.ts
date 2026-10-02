// What Vite hands back for the import forms the plugin uses; the lab's own
// modules are plain JS and type themselves through `allowJs`.
declare module '*?worker&inline' {
  const ctor: new () => Worker;
  export default ctor;
}
declare module '*?url' {
  const url: string;
  export default url;
}
declare module '*.css' {}
