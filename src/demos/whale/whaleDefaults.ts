/**
 * WhaleLab で詰めたクジラの値。本編はこれを土台にして、一部だけ調整パネルから上書きする。
 */
import type { WhaleParams } from "./whaleModel";

export const WHALE_SWIM: WhaleParams = {
  length: 0.4,
  girth: 0.99,
  finLength: 1.11,
  flukeSpan: 1.17,
  speed: 0.12,
  tailAmp: 0,
  turn: -0.8,
  bank: 1,
  depth: 1.94,
  orbit: 0.2,
  figure8: 1,
  f8w: 0.63,
  f8h: 0.48,
  f8d: 0.19,
};

export const WHALE_LOOK = {
  faceAlpha: 0,
  line: 0.13,
  point: 1.3,
  backLine: 0.22,
  lenRef: 0.045,
  pointSize: 3.7,
  persp: 0.22,
  base: 0.05,
  belly: 1.49,
  finWhite: 1,
  rim: 2.44,
  fog: 0.46,
  bgLight: 1,
};
