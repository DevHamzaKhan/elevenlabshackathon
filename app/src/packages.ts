// THE SWITCH. One line per package: the real package, or the stand-in in ../standins
// (keep the stand-in line commented as the fallback). See README.md "Swapping in".
export { startMind } from 'bobby-mind';
// export { startMind } from '../standins/mind';
export { startMouth, startCaller } from 'bobby-mouth';
// export { startMouth, startCaller } from '../standins/mouth';
