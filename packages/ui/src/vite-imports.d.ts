// Vite asset import suffixes used by the map component (resolved by the consuming app's Vite build).
declare module '*?worker&url' {
  const url: string;
  export default url;
}
