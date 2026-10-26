export interface Stream<TIn, TOut> {
  push(value: TIn, replace: boolean): TOut | null;
}

export interface UpdatableIndicator<TIn, TOut> {
  update(value: TIn, replace: boolean): TOut | null;
}

export function wrapTradingSignal<TIn, TOut>(indicator: UpdatableIndicator<TIn, TOut>): Stream<TIn, TOut> {
  return {
    push(value: TIn, replace: boolean): TOut | null {
      return indicator.update(value, replace);
    },
  };
}
