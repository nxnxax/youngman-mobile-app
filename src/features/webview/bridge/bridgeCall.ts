export function callWebBridge(method: string, ...args: unknown[]): string {
  const serialized = args.map(a => JSON.stringify(a)).join(', ');
  return `(function(){
  if (window.YoungmanBridge && typeof window.YoungmanBridge.${method} === 'function') {
    try { window.YoungmanBridge.${method}(${serialized}); } catch (e) {}
  }
})(); true;`;
}

export function dispatchWebBridge(type: string, payload: unknown): string {
  return `(function(){
  if (window.YoungmanBridge && typeof window.YoungmanBridge.handle === 'function') {
    try { window.YoungmanBridge.handle(${JSON.stringify(type)}, ${JSON.stringify(payload)}); } catch (e) {}
  }
})(); true;`;
}
