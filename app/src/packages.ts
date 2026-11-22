// THE SWITCH. One line per package: point it at the real package when it has the contract's
// entry points and builds, or at the stand-in in ../standins. See README.md "Swapping in".
//
//   real Mind:  export { startMind } from 'bobby-mind';
//   real Mouth: export { startMouth, startCaller } from 'bobby-mouth';
//
// (and add "bobby-mind": "file:../mind" / "bobby-mouth": "file:../mouth" to package.json, npm install)
export { startMind } from '../standins/mind';
export { startMouth, startCaller } from '../standins/mouth';
