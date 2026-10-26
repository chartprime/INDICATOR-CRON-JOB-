import {
  AD,
  ADOSC,
  ADX,
  ALMA,
  AO,
  Aroon,
  ATR,
  BollingerBands,
  CCI,
  CMF,
  CMO,
  CVI,
  DEMA,
  DonchianChannels,
  DPO,
  ElderRay,
  EMA,
  EMV,
  FisherTransform,
  ForceIndex,
  HMA,
  IchimokuCloud,
  KAMA,
  KeltnerChannels,
  KST,
  KVO,
  LinearRegression,
  MACD,
  MFI,
  MOM,
  NATR,
  NVI,
  OBV,
  PPO,
  PSAR,
  PVI,
  PVO,
  RMA,
  ROC,
  RSI,
  SMA,
  StochasticOscillator,
  StochasticRSI,
  SuperTrend,
  TEMA,
  TR,
  TRIX,
  TTMSqueeze,
  UlcerIndex,
  UltimateOscillator,
  VortexIndicator,
  VWAP,
  VWMA,
  WilliamsR,
  WMA,
  ZigZag,
} from "trading-signals";
import { assertInsideCreationWindow } from "./creationGuard";
import type { Stream, UpdatableIndicator } from "./stream";
import { wrapTradingSignal } from "./stream";
import { stdev } from "./stdev";
import {
  crossover,
  crossunder,
  highest,
  lowest,
  pivotHigh,
  pivotLow,
  prev,
} from "./helpers";

function makeFactory<TArgs extends unknown[], TIn, TOut>(
  name: string,
  create: (...args: TArgs) => UpdatableIndicator<TIn, TOut>,
): (...args: TArgs) => Stream<TIn, TOut> {
  return (...args: TArgs) => {
    assertInsideCreationWindow(name);
    return wrapTradingSignal(create(...args));
  };
}

function guardedHelper<TArgs extends unknown[], TIn, TOut>(
  name: string,
  create: (...args: TArgs) => Stream<TIn, TOut>,
): (...args: TArgs) => Stream<TIn, TOut> {
  return (...args: TArgs) => {
    assertInsideCreationWindow(name);
    return create(...args);
  };
}

export const ta = {
  sma: makeFactory("ta.sma", (length: number) => new SMA(length)),
  ema: makeFactory("ta.ema", (length: number) => new EMA(length)),
  wma: makeFactory("ta.wma", (length: number) => new WMA(length)),
  rma: makeFactory("ta.rma", (length: number) => new RMA(length)),
  vwma: makeFactory("ta.vwma", (length: number) => new VWMA(length)),
  alma: makeFactory(
    "ta.alma",
    (length: number, offset?: number, sigma?: number) =>
      new ALMA(length, offset, sigma),
  ),
  rsi: makeFactory("ta.rsi", (length: number) => new RSI(length)),
  macd: makeFactory(
    "ta.macd",
    (fastLength: number, slowLength: number, signalLength: number) =>
      new MACD(new EMA(fastLength), new EMA(slowLength), new EMA(signalLength)),
  ),
  stoch: makeFactory(
    "ta.stoch",
    (kPeriod: number, kSlowingPeriod: number, dPeriod: number) =>
      new StochasticOscillator({ kPeriod, kSlowingPeriod, dPeriod }),
  ),
  cci: makeFactory("ta.cci", (length: number) => new CCI(length)),
  roc: makeFactory("ta.roc", (length: number) => new ROC(length)),
  mom: makeFactory("ta.mom", (length: number) => new MOM(length)),
  atr: makeFactory("ta.atr", (length: number) => new ATR(length)),
  bollinger: makeFactory(
    "ta.bollinger",
    (length: number, mult: number) => new BollingerBands(length, mult),
  ),
  keltner: makeFactory(
    "ta.keltner",
    (atrInterval: number, emaInterval: number, multiplier: number) =>
      new KeltnerChannels({ atrInterval, emaInterval, multiplier }),
  ),
  adx: makeFactory("ta.adx", (length: number) => new ADX(length)),
  psar: makeFactory(
    "ta.psar",
    (accelerationStep: number, accelerationMax: number) =>
      new PSAR({ accelerationStep, accelerationMax }),
  ),
  vwap: makeFactory("ta.vwap", () => new VWAP()),
  obv: makeFactory("ta.obv", (length: number) => new OBV(length)),
  mfi: makeFactory("ta.mfi", (length: number) => new MFI(length)),
  // -- TA.02b: coverage extension. Same generic adapter, no new mechanism.
  hma: makeFactory("ta.hma", (length: number) => new HMA(length)),
  tema: makeFactory("ta.tema", (length: number) => new TEMA(length)),
  dema: makeFactory("ta.dema", (length: number) => new DEMA(length)),
  superTrend: makeFactory(
    "ta.superTrend",
    (interval: number, multiplier: number) =>
      new SuperTrend({ interval, multiplier }),
  ),
  ichimoku: makeFactory(
    "ta.ichimoku",
    (baseInterval: number, conversionInterval: number, spanBInterval: number) =>
      new IchimokuCloud({ baseInterval, conversionInterval, spanBInterval }),
  ),
  aroon: makeFactory("ta.aroon", (length: number) => new Aroon(length)),
  zigzag: makeFactory(
    "ta.zigzag",
    (deviation: number) => new ZigZag({ deviation }),
  ),
  kama: makeFactory("ta.kama", (length: number) => new KAMA(length)),
  vortex: makeFactory(
    "ta.vortex",
    (length: number) => new VortexIndicator(length),
  ),
  linreg: makeFactory(
    "ta.linreg",
    (length: number) => new LinearRegression(length),
  ),
  williamsR: makeFactory(
    "ta.williamsR",
    (length: number) => new WilliamsR(length),
  ),
  ao: makeFactory(
    "ta.ao",
    (shortLength: number, longLength: number) =>
      new AO(shortLength, longLength),
  ),
  ultimateOscillator: makeFactory(
    "ta.ultimateOscillator",
    (shortPeriod: number, mediumPeriod: number, longPeriod: number) =>
      new UltimateOscillator({ shortPeriod, mediumPeriod, longPeriod }),
  ),
  trix: makeFactory("ta.trix", (length: number) => new TRIX(length)),
  cmo: makeFactory("ta.cmo", (length: number) => new CMO(length)),
  fisherTransform: makeFactory(
    "ta.fisherTransform",
    (length: number) => new FisherTransform(length),
  ),
  stochasticRsi: makeFactory(
    "ta.stochasticRsi",
    (length: number) => new StochasticRSI(length),
  ),
  elderRay: makeFactory(
    "ta.elderRay",
    (length: number) => new ElderRay(length),
  ),
  dpo: makeFactory("ta.dpo", (length: number) => new DPO(length)),
  kst: makeFactory(
    "ta.kst",
    (config?: ConstructorParameters<typeof KST>[0]) => new KST(config),
  ),
  ppo: makeFactory(
    "ta.ppo",
    (fastPeriod: number, slowPeriod: number) =>
      new PPO({ fastPeriod, slowPeriod }),
  ),
  donchian: makeFactory(
    "ta.donchian",
    (length: number) => new DonchianChannels(length),
  ),
  cvi: makeFactory("ta.cvi", (length: number) => new CVI(length)),
  ulcerIndex: makeFactory(
    "ta.ulcerIndex",
    (length: number) => new UlcerIndex(length),
  ),
  ttmSqueeze: makeFactory(
    "ta.ttmSqueeze",
    (
      bbInterval: number,
      bbMultiplier: number,
      kcInterval: number,
      kcMultiplier: number,
    ) => new TTMSqueeze({ bbInterval, bbMultiplier, kcInterval, kcMultiplier }),
  ),
  natr: makeFactory("ta.natr", (length: number) => new NATR(length)),
  tr: makeFactory("ta.tr", () => new TR()),
  cmf: makeFactory("ta.cmf", (length: number) => new CMF(length)),
  ad: makeFactory("ta.ad", () => new AD()),
  kvo: makeFactory(
    "ta.kvo",
    (shortLength: number, longLength: number) =>
      new KVO(shortLength, longLength),
  ),
  nvi: makeFactory("ta.nvi", () => new NVI()),
  pvi: makeFactory("ta.pvi", () => new PVI()),
  emv: makeFactory(
    "ta.emv",
    (length: number, scale?: number) => new EMV(length, scale),
  ),
  forceIndex: makeFactory(
    "ta.forceIndex",
    (length: number) => new ForceIndex(length),
  ),
  pvo: makeFactory(
    "ta.pvo",
    (fastPeriod: number, slowPeriod: number) =>
      new PVO({ fastPeriod, slowPeriod }),
  ),
  adosc: makeFactory(
    "ta.adosc",
    (fastPeriod: number, slowPeriod: number) =>
      new ADOSC({ fastPeriod, slowPeriod }),
  ),
  stdev: guardedHelper("ta.stdev", stdev),
  highest: guardedHelper("ta.highest", highest),
  lowest: guardedHelper("ta.lowest", lowest),
  pivotHigh: guardedHelper("ta.pivotHigh", pivotHigh),
  pivotLow: guardedHelper("ta.pivotLow", pivotLow),
  prev: guardedHelper("ta.prev", prev),
  crossover: guardedHelper("ta.crossover", crossover),
  crossunder: guardedHelper("ta.crossunder", crossunder),
};
