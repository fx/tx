import { Window } from "happy-dom";

const window = new Window({ url: "https://example.com" });
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  matchMedia: window.matchMedia.bind(window),
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
