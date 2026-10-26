export const LOG_SLIDER_STEPS = 1000;

export function logSliderToValue(position: number, min: number, max: number): number {
  if (!Number.isFinite(min) || min <= 0) {
    throw new Error("logSliderToValue: min must be a positive finite number");
  }
  if (!Number.isFinite(max) || max <= min) {
    throw new Error("logSliderToValue: max must be a finite number greater than min");
  }
  if (!Number.isFinite(position)) {
    throw new Error("logSliderToValue: position must be a finite number");
  }
  const clamped = Math.min(Math.max(position, 0), LOG_SLIDER_STEPS);
  return min * Math.pow(max / min, clamped / LOG_SLIDER_STEPS);
}

export function valueToLogSlider(value: number, min: number, max: number): number {
  if (!Number.isFinite(min) || min <= 0) {
    throw new Error("valueToLogSlider: min must be a positive finite number");
  }
  if (!Number.isFinite(max) || max <= min) {
    throw new Error("valueToLogSlider: max must be a finite number greater than min");
  }
  if (!Number.isFinite(value) || value <= 0) return 0;
  const clamped = Math.min(Math.max(value, min), max);
  return Math.round(LOG_SLIDER_STEPS * (Math.log(clamped / min) / Math.log(max / min)));
}

export function logSliderMidpoint(min: number, max: number): number {
  return logSliderToValue(LOG_SLIDER_STEPS / 2, min, max);
}
